"""Voiceprint store and transcript hand-off: Postgres, database `speech` (only this service has its credentials).

Meeting transcripts are kept for TRANSCRIPT_RETENTION_DAYS (default 30) under an id the user sees
("[transcript_id: TR-…]"), so the Meeting Agent can copy the speaker-labelled lines into its own
records by that id instead of the model re-typing them; past that date they are deleted.

Only the embedding is kept — enrollment audio never touches disk. A voiceprint is
biometric data (개인정보보호법 민감정보): stored with the consent time, deletable by its owner,
and encrypted at rest (개인정보의 안전성 확보조치 기준 제7조) with a key that lives only in the
environment, so a database dump alone does not reveal it. Matching happens in memory, never in SQL.

A voiceprint also comes from a meeting (source 'meeting'): the average voice of each unnamed speaker
("화자 C") of a meeting transcript is kept encrypted for SPEAKER_SAMPLE_DAYS (default 7). When the
Meeting Agent's user confirms who "화자 C" was, and that person agreed at the meeting's QR check-in,
learn() turns that voice into their voiceprint; samples nobody is confirmed for are deleted unused.
An enrolled voiceprint (source 'enroll', three read-aloud samples) is never replaced this way.
"""

from __future__ import annotations

import base64
import os
import re
import secrets
from datetime import datetime

import numpy as np
import psycopg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from speech import Voiceprint

DATABASE_URL = os.environ.get("SPEECH_DATABASE_URL", "")
VOICEPRINT_KEY = os.environ.get("VOICEPRINT_KEY", "")  # base64 of 32 random bytes; lost key = everyone re-enrolls
TRANSCRIPT_RETENTION_DAYS = int(os.environ.get("TRANSCRIPT_RETENTION_DAYS", "30"))
SPEAKER_SAMPLE_DAYS = int(os.environ.get("SPEAKER_SAMPLE_DAYS", "7"))
# Less speech than this in the meeting and the voice is not learned (too little to recognise it again).
LEARN_MIN_SECONDS = float(os.environ.get("VOICE_LEARN_MIN_SECONDS", "30"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS voiceprints (
    user_sub     text PRIMARY KEY,          -- Keycloak user id
    email        text NOT NULL,
    display_name text NOT NULL,             -- 회의록에 표시될 이름
    title        text,                      -- 직책 (예: CFO)
    embedding    bytea NOT NULL,            -- AES-256-GCM: nonce(12) ‖ ciphertext, AAD = user_sub|model
    model        text NOT NULL,             -- 다른 모델의 embedding과는 비교할 수 없음
    samples      int  NOT NULL,
    consent_at   timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transcripts (
    id           text PRIMARY KEY,          -- TR-20261028-1A2B3C (텍스트 첫 줄에 표시)
    source_name  text,                      -- 업로드 파일 이름
    duration     real NOT NULL,
    engine       text NOT NULL,
    turns        jsonb NOT NULL,            -- [{start, end, speaker, score, text}]
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS transcripts_expires ON transcripts (expires_at);
ALTER TABLE voiceprints ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'enroll';  -- enroll: /voice/ 등록 · meeting: 회의 녹음에서 익힘
CREATE TABLE IF NOT EXISTS speaker_samples (
    transcript_id text NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    label         text NOT NULL,            -- 화자 C (목소리를 찾지 못한 발언자)
    embedding     bytea NOT NULL,           -- AES-256-GCM, AAD = transcript_id|label|model
    model         text NOT NULL,
    seconds       real NOT NULL,            -- 그 목소리의 발언 길이
    expires_at    timestamptz NOT NULL,     -- 누구인지 정해지지 않으면 이때 삭제
    PRIMARY KEY (transcript_id, label)
);
CREATE INDEX IF NOT EXISTS speaker_samples_expires ON speaker_samples (expires_at);
"""


def _connect() -> psycopg.Connection:
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=True)


def _aead() -> AESGCM:
    key = base64.b64decode(VOICEPRINT_KEY)
    if len(key) != 32:
        raise RuntimeError("VOICEPRINT_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)")
    return AESGCM(key)


def init() -> None:
    _aead()  # no key, no voiceprints: fail at startup rather than store biometrics in the clear
    with _connect() as conn:
        conn.execute(SCHEMA)


# The AAD binds a ciphertext to its row: copied onto another user's row it no longer decrypts.
def _seal(user_sub: str, model: str, v: np.ndarray) -> bytes:
    nonce = os.urandom(12)
    return nonce + _aead().encrypt(nonce, v.astype(np.float32).tobytes(), f"{user_sub}|{model}".encode())


def _open(user_sub: str, model: str, blob: bytes) -> np.ndarray:
    blob = bytes(blob)
    return np.frombuffer(_aead().decrypt(blob[:12], blob[12:], f"{user_sub}|{model}".encode()), dtype=np.float32)


def label_of(display_name: str, title: str | None) -> str:
    return f"{display_name} ({title})" if title else display_name


def split_label(label: str) -> tuple[str, str | None]:
    """"최유진 (팀장)" → ("최유진", "팀장")."""
    m = re.match(r"^\s*(.+?)\s*\(([^()]+)\)\s*$", label or "")
    return (m.group(1), m.group(2).strip()) if m else ((label or "").strip(), None)


def upsert(user_sub: str, email: str, display_name: str, title: str | None,
           embedding: np.ndarray, model: str, samples: int) -> None:
    with _connect() as conn:
        conn.execute(
            """INSERT INTO voiceprints (user_sub, email, display_name, title, embedding, model, samples, consent_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, now())
               ON CONFLICT (user_sub) DO UPDATE SET
                   email = EXCLUDED.email, display_name = EXCLUDED.display_name, title = EXCLUDED.title,
                   embedding = EXCLUDED.embedding, model = EXCLUDED.model, samples = EXCLUDED.samples,
                   source = 'enroll', consent_at = now(), updated_at = now()""",
            (user_sub, email, display_name, title, _seal(user_sub, model, embedding), model, samples),
        )


def get(user_sub: str) -> dict | None:
    with _connect() as conn:
        return conn.execute(
            "SELECT email, display_name, title, model, samples, source, consent_at, updated_at FROM voiceprints WHERE user_sub = %s",
            (user_sub,),
        ).fetchone()


def delete(user_sub: str) -> bool:
    with _connect() as conn:
        return conn.execute("DELETE FROM voiceprints WHERE user_sub = %s", (user_sub,)).rowcount > 0


def all_voiceprints(model: str) -> list[Voiceprint]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT user_sub, display_name, title, embedding FROM voiceprints WHERE model = %s",
            (model,),
        ).fetchall()
    return [Voiceprint(r["user_sub"], label_of(r["display_name"], r["title"]), _open(r["user_sub"], model, r["embedding"]))
            for r in rows]


def count(model: str) -> int:
    with _connect() as conn:
        return conn.execute("SELECT count(*) AS n FROM voiceprints WHERE model = %s", (model,)).fetchone()["n"]


def save_transcript(source_name: str, duration: float, engine: str, turns: list[dict]) -> str:
    with _connect() as conn:
        while True:
            tid = f"TR-{datetime.now().strftime('%Y%m%d')}-{secrets.token_hex(3).upper()}"
            row = conn.execute(
                """INSERT INTO transcripts (id, source_name, duration, engine, turns, expires_at)
                   VALUES (%s, %s, %s, %s, %s, now() + make_interval(days => %s)) ON CONFLICT (id) DO NOTHING RETURNING id""",
                (tid, source_name, duration, engine, Jsonb(turns), TRANSCRIPT_RETENTION_DAYS),
            ).fetchone()
            if row:
                return tid


def get_transcript(tid: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, source_name, duration, engine, turns, created_at FROM transcripts WHERE id = %s AND expires_at > now()",
            (tid,),
        ).fetchone()
    if row is None:
        return None
    return {**row, "created_at": iso(row["created_at"])}


def purge_transcripts() -> int:
    with _connect() as conn:
        conn.execute("DELETE FROM speaker_samples WHERE expires_at <= now()")
        return conn.execute("DELETE FROM transcripts WHERE expires_at <= now()").rowcount


def _sample_aad(tid: str, label: str, model: str) -> bytes:
    return f"{tid}|{label}|{model}".encode()


def save_samples(tid: str, model: str, samples: dict[str, tuple[np.ndarray, float]]) -> None:
    """The unnamed voices of one transcript, kept briefly so a confirmed, consenting person's voice can be learned."""
    with _connect() as conn:
        for label, (v, seconds) in samples.items():
            nonce = os.urandom(12)
            blob = nonce + _aead().encrypt(nonce, v.astype(np.float32).tobytes(), _sample_aad(tid, label, model))
            conn.execute(
                """INSERT INTO speaker_samples (transcript_id, label, embedding, model, seconds, expires_at)
                   VALUES (%s, %s, %s, %s, %s, now() + make_interval(days => %s)) ON CONFLICT DO NOTHING""",
                (tid, label, blob, model, seconds, SPEAKER_SAMPLE_DAYS),
            )


def learn(tid: str, label: str, user_sub: str, email: str, name: str, consent_at: datetime, model: str) -> str:
    """"화자 C" of transcript `tid` was `user_sub`, who agreed: that voice becomes (or refines) their voiceprint.
    learned · already_enrolled (a read-aloud enrollment is kept as is) · too_short · expired (no sample any more)."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT embedding, seconds FROM speaker_samples WHERE transcript_id = %s AND label = %s AND model = %s AND expires_at > now()",
            (tid, label, model),
        ).fetchone()
        if row is None:
            return "expired"
        if row["seconds"] < LEARN_MIN_SECONDS:
            return "too_short"
        blob = bytes(row["embedding"])
        voice = np.frombuffer(_aead().decrypt(blob[:12], blob[12:], _sample_aad(tid, label, model)), dtype=np.float32)
        mine = conn.execute("SELECT source, model, samples, embedding FROM voiceprints WHERE user_sub = %s", (user_sub,)).fetchone()
        if mine and mine["model"] == model and mine["source"] == "enroll":
            conn.execute("DELETE FROM speaker_samples WHERE transcript_id = %s AND label = %s", (tid, label))
            return "already_enrolled"
        samples = 1
        if mine and mine["model"] == model:  # learned before: average with the earlier meetings
            old = _open(user_sub, model, mine["embedding"])
            voice = old * mine["samples"] + voice
            voice = voice / (np.linalg.norm(voice) or 1.0)
            samples = mine["samples"] + 1
        display_name, title = split_label(name)
        conn.execute(
            """INSERT INTO voiceprints (user_sub, email, display_name, title, embedding, model, samples, source, consent_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, 'meeting', %s)
               ON CONFLICT (user_sub) DO UPDATE SET
                   email = EXCLUDED.email, display_name = EXCLUDED.display_name, title = EXCLUDED.title,
                   embedding = EXCLUDED.embedding, model = EXCLUDED.model, samples = EXCLUDED.samples,
                   source = 'meeting', consent_at = EXCLUDED.consent_at, updated_at = now()""",
            (user_sub, email, display_name or email, title, _seal(user_sub, model, voice), model, samples, consent_at),
        )
        conn.execute("DELETE FROM speaker_samples WHERE transcript_id = %s AND label = %s", (tid, label))
    return "learned"


def iso(ts: datetime | None) -> str | None:
    return ts.isoformat() if ts else None
