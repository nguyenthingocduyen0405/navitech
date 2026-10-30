"""speech-service — speaker-labelled STT for Open WebUI + voice enrollment page.

    POST /v1/audio/transcriptions   OpenAI-compatible; Open WebUI's STT engine "openai" points here
                                     (internal network only, Bearer SPEECH_API_KEY). A meeting transcript
                                     (speaker lines) is kept under an id shown on its first line
    GET  /internal/transcripts/{id}  that transcript for the Meeting Agent (internal network only, same key)
    /voice/                          enrollment page behind Keycloak login (nginx routes /voice/ here)
    /voice/api/me | enroll | test    the page's API (session cookie)

Enrollment: three read-aloud samples → VAD-trimmed speech → one embedding each → consistency
check → mean embedding stored as the voiceprint. The audio itself is never written to disk.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import secrets
import threading
import time
from itertools import combinations
from pathlib import Path
from urllib.parse import urlencode

import httpx
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

import speech
import store

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("speech-service")

API_KEY = os.environ.get("SPEECH_API_KEY", "").strip()
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")  # https://host:port/voice
OIDC_PUBLIC_ISSUER = os.environ.get("OIDC_PUBLIC_ISSUER", "").rstrip("/")  # browser-facing Keycloak realm URL
OIDC_INTERNAL_ISSUER = os.environ.get("OIDC_INTERNAL_ISSUER", "").rstrip("/")  # same realm, docker network
OIDC_CLIENT_ID = os.environ.get("OIDC_CLIENT_ID", "voice-enroll")
OIDC_CLIENT_SECRET = os.environ.get("OIDC_CLIENT_SECRET", "")

ENROLL_SAMPLES = 3
ENROLL_MIN_SPEECH_SECONDS = 5.0
# Two samples of one person below this score: noise, a different reader, or a bad mic.
ENROLL_CONSISTENCY = float(os.environ.get("ENROLL_CONSISTENCY", "0.55"))
STATIC = Path(__file__).parent / "static"
TRANSCRIPT_ID = re.compile(r"^TR-\d{8}-[0-9A-F]{6}$")
PURGE_INTERVAL_SECONDS = 3600

app = FastAPI(title="speech-service", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ.get("SESSION_SECRET") or secrets.token_hex(32),
    session_cookie="voice_session",
    path="/voice",
    https_only=PUBLIC_BASE_URL.startswith("https://"),
    same_site="lax",
    max_age=8 * 3600,
)


@app.on_event("startup")
def startup() -> None:
    store.init()
    speech.extractor()  # load the embedding model before the first request
    threading.Thread(target=_purge_loop, name="transcript-purge", daemon=True).start()
    log.info("ready: stt_engine=%s, voiceprints=%d", speech.stt_engine(), store.count(speech.model_name()))


def _purge_loop() -> None:
    """Meeting transcripts past TRANSCRIPT_RETENTION_DAYS are deleted (the Meeting Agent keeps its own copy)."""
    while True:
        try:
            purged = store.purge_transcripts()
            if purged:
                log.info("purged %d expired transcripts", purged)
        except Exception:
            log.exception("transcript purge failed")
        time.sleep(PURGE_INTERVAL_SECONDS)


def _authorized(request: Request) -> bool:
    return not API_KEY or secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {API_KEY}")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "stt_engine": speech.stt_engine(), "voiceprints": store.count(speech.model_name())}


# ---------------------------------------------------------------------------
# OpenAI-compatible transcription (Open WebUI)
# ---------------------------------------------------------------------------


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    request: Request,
    file: UploadFile = File(...),
    model: str = Form(""),
    language: str | None = Form(None),
):
    if not _authorized(request):
        return JSONResponse({"error": {"message": "invalid API key"}}, status_code=401)
    data = await file.read()
    try:
        voiceprints = store.all_voiceprints(speech.model_name())
        result = await run_in_threadpool(speech.transcribe, data, file.filename or "audio", voiceprints, language)
    except speech.AudioError as e:
        return JSONResponse({"error": {"message": str(e)}}, status_code=400)
    if result.pop("labelled", False):
        try:
            tid = store.save_transcript(file.filename or "audio", result["duration"], result["engine"], result["turns"])
        except Exception:  # the transcript text still reaches the chat; only the hand-off id is missing
            log.exception("could not keep the transcript")
        else:
            result["transcript_id"] = tid
            result["text"] = f"[transcript_id: {tid}]\n" + result["text"]
    return result


@app.get("/internal/transcripts/{tid}")
def transcript(tid: str, request: Request):
    """A kept meeting transcript, for the Meeting Agent (internal network only; nginx exposes /voice/ only)."""
    if not _authorized(request):
        return JSONResponse({"error": "invalid API key"}, status_code=401)
    if not TRANSCRIPT_ID.match(tid):
        return JSONResponse({"error": "not found"}, status_code=404)
    found = store.get_transcript(tid)
    if found is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return found


# ---------------------------------------------------------------------------
# Keycloak login (authorization code flow) for the enrollment page
# ---------------------------------------------------------------------------


def _claims(id_token: str) -> dict:
    # The token comes straight from Keycloak's token endpoint over the back channel,
    # so its signature is not re-verified here (OIDC Core 3.1.3.7).
    payload = id_token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


@app.get("/voice/login")
def login(request: Request):
    state = secrets.token_urlsafe(24)
    request.session["state"] = state
    query = urlencode({
        "client_id": OIDC_CLIENT_ID, "response_type": "code", "scope": "openid email profile",
        "redirect_uri": f"{PUBLIC_BASE_URL}/callback", "state": state,
    })
    return RedirectResponse(f"{OIDC_PUBLIC_ISSUER}/protocol/openid-connect/auth?{query}")


@app.get("/voice/callback")
def callback(request: Request, code: str = "", state: str = ""):
    if not code or not state or state != request.session.pop("state", None):
        return RedirectResponse(f"{PUBLIC_BASE_URL}/login")
    r = httpx.post(
        f"{OIDC_INTERNAL_ISSUER}/protocol/openid-connect/token",
        data={
            "grant_type": "authorization_code", "code": code, "redirect_uri": f"{PUBLIC_BASE_URL}/callback",
            "client_id": OIDC_CLIENT_ID, "client_secret": OIDC_CLIENT_SECRET,
        },
        timeout=10,
    )
    if r.status_code != 200:
        log.warning("token exchange failed: %s %s", r.status_code, r.text[:200])
        raise HTTPException(502, "로그인에 실패했습니다. 다시 시도해 주세요.")
    c = _claims(r.json()["id_token"])
    request.session["user"] = {
        "sub": c["sub"], "email": c.get("email", ""),
        "name": c.get("name") or c.get("preferred_username", ""),
    }
    return RedirectResponse(f"{PUBLIC_BASE_URL}/")


@app.get("/voice/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse(f"{OIDC_PUBLIC_ISSUER}/protocol/openid-connect/logout?"
                            + urlencode({"client_id": OIDC_CLIENT_ID, "post_logout_redirect_uri": f"{PUBLIC_BASE_URL}/"}))


def _user(request: Request) -> dict:
    user = request.session.get("user")
    if not user:
        raise HTTPException(401, "로그인이 필요합니다.")
    return user


@app.get("/voice")
def voice_root():
    return RedirectResponse(f"{PUBLIC_BASE_URL}/")


@app.get("/voice/")
def page(request: Request):
    if not request.session.get("user"):
        return RedirectResponse(f"{PUBLIC_BASE_URL}/login")
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------------------
# Enrollment API
# ---------------------------------------------------------------------------


@app.get("/voice/api/me")
def me(request: Request) -> dict:
    user = _user(request)
    row = store.get(user["sub"])
    return {
        "user": {"email": user["email"], "name": user["name"]},
        "enrolled": bool(row) and row["model"] == speech.model_name(),
        "voiceprint": row and {
            "display_name": row["display_name"], "title": row["title"], "samples": row["samples"],
            "consent_at": store.iso(row["consent_at"]), "updated_at": store.iso(row["updated_at"]),
            "outdated": row["model"] != speech.model_name(),
        },
        "enrolled_count": store.count(speech.model_name()),
    }


def _sample_embedding(data: bytes, index: int) -> tuple[np.ndarray, float]:
    try:
        voice = speech.speech_only(speech.decode(data))
    except speech.AudioError:
        raise HTTPException(400, f"{index}번 녹음을 읽을 수 없습니다. 다시 녹음해 주세요.")
    seconds = len(voice) / speech.SAMPLE_RATE
    if seconds < ENROLL_MIN_SPEECH_SECONDS:
        raise HTTPException(400, f"{index}번 녹음의 음성이 {seconds:.1f}초로 짧습니다. 문장을 끝까지 읽어 주세요 "
                                 f"(최소 {ENROLL_MIN_SPEECH_SECONDS:.0f}초).")
    return speech.embed(voice), seconds


@app.post("/voice/api/enroll")
async def enroll(
    request: Request,
    samples: list[UploadFile] = File(...),
    display_name: str = Form(...),
    title: str = Form(""),
    consent: bool = Form(False),
):
    user = _user(request)
    if not consent:
        raise HTTPException(400, "민감정보(음성 특징값) 수집·이용에 동의해야 등록할 수 있습니다.")
    display_name, title = display_name.strip()[:40], title.strip()[:40]
    if not display_name:
        raise HTTPException(400, "표시 이름을 입력해 주세요.")
    if len(samples) != ENROLL_SAMPLES:
        raise HTTPException(400, f"녹음 {ENROLL_SAMPLES}개가 필요합니다.")
    datas = [await s.read() for s in samples]

    def compute():
        with speech._JOB_LOCK:
            return [_sample_embedding(d, i) for i, d in enumerate(datas, 1)]

    results = await run_in_threadpool(compute)
    embeddings = [e for e, _ in results]
    pair_scores = [float(a @ b) for a, b in combinations(embeddings, 2)]
    if min(pair_scores) < ENROLL_CONSISTENCY:
        raise HTTPException(400, "녹음끼리 목소리 특징이 일정하지 않습니다. 조용한 곳에서 같은 거리로 다시 녹음해 주세요 "
                                 f"(일치도 {min(pair_scores):.2f} < {ENROLL_CONSISTENCY:.2f}).")
    mean = np.mean(embeddings, axis=0)
    mean = mean / (np.linalg.norm(mean) or 1.0)

    # A voice very close to someone else's will be confused in meetings: say so, still enroll.
    others = [(v, s) for v, s in speech.identify(mean, store.all_voiceprints(speech.model_name())) if v.user_sub != user["sub"]]
    similar = sum(1 for _, s in others if s >= speech.MATCH_THRESHOLD)  # a count only: no other names

    store.upsert(user["sub"], user["email"], display_name, title or None, mean, speech.model_name(), len(embeddings))
    log.info("voiceprint enrolled: %s (consistency min %.2f)", user["email"], min(pair_scores))
    return {
        "ok": True,
        "label": store.label_of(display_name, title or None),
        "speech_seconds": [round(s, 1) for _, s in results],
        "consistency": round(min(pair_scores), 3),
        "similar_voice_count": similar,
    }


@app.delete("/voice/api/enroll")
def unenroll(request: Request) -> dict:
    user = _user(request)
    deleted = store.delete(user["sub"])
    log.info("voiceprint deleted: %s (%s)", user["email"], deleted)
    return {"ok": True, "deleted": deleted}


@app.post("/voice/api/test")
async def test(request: Request, sample: UploadFile = File(...)):
    """Self-check: is this clip recognised as *your* voice? Other people's names and scores
    are never returned, so the endpoint cannot be used to find out whose voice a clip is."""
    user = _user(request)
    data = await sample.read()

    def compute():
        with speech._JOB_LOCK:
            voice = speech.speech_only(speech.decode(data))
            if len(voice) / speech.SAMPLE_RATE < speech.MIN_EMBED_SECONDS * 2:
                raise HTTPException(400, "음성이 너무 짧습니다. 2초 이상 말해 주세요.")
            return speech.identify(speech.embed(voice), store.all_voiceprints(speech.model_name()))

    try:
        ranked = await run_in_threadpool(compute)
    except speech.AudioError:
        raise HTTPException(400, "녹음을 읽을 수 없습니다.")
    own = next((s for v, s in ranked if v.user_sub == user["sub"]), None)
    if own is None:
        raise HTTPException(400, "먼저 음성을 등록해 주세요.")
    best_voice, best_score = ranked[0]
    return {
        "recognized_as_you": best_voice.user_sub == user["sub"] and best_score >= speech.MATCH_THRESHOLD,
        "your_score": round(own, 3),
        "threshold": speech.MATCH_THRESHOLD,
        "confused_with_other": best_voice.user_sub != user["sub"] and best_score >= speech.MATCH_THRESHOLD,
    }
