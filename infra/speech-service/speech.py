"""Audio → speaker-labelled transcript.

    decode (ffmpeg, 16 kHz mono)
      → VAD segments (silero)                      speech turns, independent of the STT engine
      → speaker embedding per segment (CAM++)
      → speakers: the whole recording's segments clustered, each cluster compared with the enrolled voiceprints
      → text: local SenseVoice per speaker turn, or Groq Whisper (segments mapped onto the VAD turns)
      → consecutive segments of one speaker merged into one line

Speaker decisions are always made on the VAD segments, so the STT engine only supplies text.
Segments shorter than MIN_EMBED_SECONDS carry too little voice to identify and take their
neighbour's label. Clustering looks at all segments at once (not one by one as they come),
so a voice that sounds a little different later in the meeting still joins its own cluster,
and fragments too small to be a speaker join the closest one. A cluster whose average voice
matches an enrolled voiceprint gets that name; the others become "화자 A", "화자 B", … in the
order they first speak (with nobody enrolled, the whole meeting is labelled this way).
"""

from __future__ import annotations

import io
import logging
import os
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from functools import lru_cache

import httpx
import numpy as np
import sherpa_onnx

log = logging.getLogger("speech")

SAMPLE_RATE = 16000
MODELS = os.environ.get("MODELS_DIR", "/models")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "campplus.onnx")
NUM_THREADS = int(os.environ.get("NUM_THREADS", "2"))

# Cosine score between a speaker cluster's average voice and an enrolled voiceprint needed to name it.
MATCH_THRESHOLD = float(os.environ.get("VOICE_MATCH_THRESHOLD", "0.5"))
# Speaker clusters: average-linkage clustering stops when the two closest clusters are less alike than this.
# Calibrated 2026-11-02: synthetic voices separate at 0.40–0.45, a real 57-minute meeting (phone, 4 people)
# gives the same 4 speakers anywhere in 0.35–0.5.
CLUSTER_THRESHOLD = float(os.environ.get("SPEAKER_CLUSTER_THRESHOLD", "0.45"))
# A cluster with less speech than this share of the recording (at most MINOR_SPEAKER_MAX_SECONDS) is a fragment
# of a voice (a cough, a far-off word, room noise) and joins the closest larger cluster.
MINOR_SPEAKER_SHARE = 0.02
MINOR_SPEAKER_MAX_SECONDS = 30.0
MIN_EMBED_SECONDS = 1.0
# Text is recognised per speaker turn (not per VAD segment), capped so SenseVoice stays accurate.
TURN_MAX_SECONDS = 25.0
TURN_CONTEXT_SECONDS = 0.2
# Short single-speaker audio (the chat mic) is returned as plain text, without labels.
DICTATION_MAX_SECONDS = 120

STT_ENGINE = os.environ.get("STT_ENGINE", "auto").lower()  # auto | groq | local
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_BASE_URL = os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
GROQ_STT_MODEL = os.environ.get("GROQ_STT_MODEL", "whisper-large-v3-turbo")
GROQ_MAX_BYTES = 24 * 1024 * 1024  # Groq's upload limit is 25 MB: larger recordings are re-encoded first
STT_LANGUAGE = os.environ.get("STT_LANGUAGE", "ko")

UNKNOWN = "화자"  # + A, B, …: a voice that matched no enrolled voiceprint


def unknown_label(k: int) -> str:
    """0 → "화자 A", 25 → "화자 Z", 26 → "화자 AA"."""
    letters = ""
    k += 1
    while k:
        k, r = divmod(k - 1, 26)
        letters = chr(ord("A") + r) + letters
    return f"{UNKNOWN} {letters}"


def stt_engine() -> str:
    if STT_ENGINE in ("groq", "local"):
        return STT_ENGINE
    return "groq" if GROQ_API_KEY else "local"


# ---------------------------------------------------------------------------
# Models (loaded once, shared by all requests)
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def extractor() -> sherpa_onnx.SpeakerEmbeddingExtractor:
    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=f"{MODELS}/{EMBEDDING_MODEL}", num_threads=NUM_THREADS
    )
    return sherpa_onnx.SpeakerEmbeddingExtractor(config)


@lru_cache(maxsize=1)
def recognizer() -> sherpa_onnx.OfflineRecognizer:
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=f"{MODELS}/sense-voice/model.int8.onnx",
        tokens=f"{MODELS}/sense-voice/tokens.txt",
        num_threads=NUM_THREADS,
        language=STT_LANGUAGE,
        use_itn=True,
    )


def _vad_config() -> sherpa_onnx.VadModelConfig:
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = f"{MODELS}/silero_vad.onnx"
    config.silero_vad.threshold = 0.5
    config.silero_vad.min_silence_duration = 0.4
    config.silero_vad.min_speech_duration = 0.25
    config.silero_vad.max_speech_duration = 20
    config.sample_rate = SAMPLE_RATE
    config.num_threads = 1
    return config


def model_name() -> str:
    """Stored with each voiceprint: embeddings from different models are not comparable."""
    return EMBEDDING_MODEL


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------


class AudioError(ValueError):
    pass


def decode(data: bytes) -> np.ndarray:
    """Any container/codec ffmpeg reads → float32 mono 16 kHz. From a file, not a pipe: phone recordings (m4a)
    keep their index at the end of the file, which ffmpeg cannot seek to in a pipe."""
    with tempfile.NamedTemporaryFile(prefix="speech-", suffix=".audio") as f:
        f.write(data)
        f.flush()
        proc = subprocess.run(
            ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", f.name,
             "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1"],
            capture_output=True, check=False,
        )
    if proc.returncode != 0 or not proc.stdout:
        raise AudioError(f"오디오를 읽을 수 없습니다: {proc.stderr.decode(errors='ignore').strip()[:200]}")
    return np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0


@dataclass
class Segment:
    start: float
    end: float
    samples: np.ndarray = field(repr=False)
    label: str | None = None  # display label, or None until decided
    score: float = 0.0  # best voiceprint score
    embedding: np.ndarray | None = field(default=None, repr=False)

    @property
    def duration(self) -> float:
        return self.end - self.start


def vad_segments(audio: np.ndarray) -> list[Segment]:
    vad = sherpa_onnx.VoiceActivityDetector(_vad_config(), buffer_size_in_seconds=60)
    window = vad.config.silero_vad.window_size
    out: list[Segment] = []

    def drain() -> None:
        while not vad.empty():
            seg = vad.front
            samples = np.array(seg.samples, dtype=np.float32)
            start = seg.start / SAMPLE_RATE
            out.append(Segment(start, start + len(samples) / SAMPLE_RATE, samples))
            vad.pop()

    for i in range(0, len(audio), window):
        vad.accept_waveform(audio[i:i + window])
        drain()
    vad.flush()
    drain()
    return out


def embed(samples: np.ndarray) -> np.ndarray:
    ex = extractor()
    stream = ex.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    stream.input_finished()
    v = np.array(ex.compute(stream), dtype=np.float32)
    return v / (np.linalg.norm(v) or 1.0)


def speech_only(audio: np.ndarray) -> np.ndarray:
    """VAD-trimmed speech of an enrollment sample (silence dilutes the voiceprint)."""
    segments = vad_segments(audio)
    return np.concatenate([s.samples for s in segments]) if segments else np.zeros(0, dtype=np.float32)


# ---------------------------------------------------------------------------
# Identification
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Voiceprint:
    user_sub: str
    label: str  # "박지훈 (CFO)"
    embedding: np.ndarray


def identify(embedding: np.ndarray, voiceprints: list[Voiceprint]) -> list[tuple[Voiceprint, float]]:
    """Voiceprints ranked by cosine score (embeddings are unit length)."""
    if not voiceprints:
        return []
    matrix = np.stack([v.embedding for v in voiceprints])
    scores = matrix @ embedding
    order = np.argsort(-scores)
    return [(voiceprints[i], float(scores[i])) for i in order]


def _centroid(embeddings: np.ndarray, weights: np.ndarray) -> np.ndarray:
    v = (embeddings * weights[:, None]).sum(axis=0)
    return v / (np.linalg.norm(v) or 1.0)


def cluster(embeddings: np.ndarray, threshold: float) -> list[list[int]]:
    """Average-linkage agglomerative clustering on cosine similarity (embeddings are unit length): merge the two
    most alike clusters until none are at least `threshold` alike. Returns lists of row indices."""
    n = len(embeddings)
    sim = (embeddings @ embeddings.T).astype(np.float32)
    np.fill_diagonal(sim, -np.inf)
    size = np.ones(n, dtype=np.float32)
    members = [[i] for i in range(n)]
    while n > 1:
        i, j = divmod(int(np.argmax(sim)), n)
        if sim[i, j] < threshold:
            break
        row = (sim[i] * size[i] + sim[j] * size[j]) / (size[i] + size[j])  # -inf stays -inf (gone, or itself)
        size[i] += size[j]
        members[i] += members[j]
        members[j] = []
        sim[i, :] = row
        sim[:, i] = row
        sim[j, :] = -np.inf
        sim[:, j] = -np.inf
    return [m for m in members if m]


def absorb_minor(groups: list[list[int]], embeddings: np.ndarray, seconds: np.ndarray) -> list[list[int]]:
    """Clusters with too little speech to be a speaker join the major cluster whose average voice is closest."""
    floor = min(MINOR_SPEAKER_SHARE * float(seconds.sum()), MINOR_SPEAKER_MAX_SECONDS)
    groups = sorted(groups, key=lambda g: -float(seconds[g].sum()))
    major = [g for g in groups if seconds[g].sum() >= floor] or groups[:1]
    centroids = [_centroid(embeddings[g], seconds[g]) for g in major]
    for g in groups[len(major):]:
        c = _centroid(embeddings[g], seconds[g])
        major[int(np.argmax([m @ c for m in centroids]))] += g
    return major


def label_segments(segments: list[Segment], voiceprints: list[Voiceprint]) -> None:
    voiced = [s for s in segments if s.duration >= MIN_EMBED_SECONDS]
    for seg in voiced:
        seg.embedding = embed(seg.samples)
    if voiced:
        emb = np.stack([s.embedding for s in voiced])
        seconds = np.array([s.duration for s in voiced], dtype=np.float32)
        scores = emb @ np.stack([v.embedding for v in voiceprints]).T if voiceprints else np.zeros((len(voiced), 0))
        groups = absorb_minor(cluster(emb, CLUSTER_THRESHOLD), emb, seconds)
        unknown = 0
        for g in sorted(groups, key=lambda g: min(voiced[i].start for i in g)):  # letters in speaking order
            ranked = identify(_centroid(emb[g], seconds[g]), voiceprints)
            if ranked and ranked[0][1] >= MATCH_THRESHOLD:
                k = next(n for n, v in enumerate(voiceprints) if v is ranked[0][0])
                label = ranked[0][0].label
            else:
                k, label = None, unknown_label(unknown)
                unknown += 1
            for i in g:
                voiced[i].label = label
                row = scores[i]
                voiced[i].score = float(row[k]) if k is not None else (float(row.max()) if row.size else 0.0)
    # Too short to identify: take the speaker of the closest identified segment in time.
    identified = [s for s in segments if s.label]
    for seg in segments:
        if seg.label is None:
            nearest = min(identified, key=lambda s: max(s.start - seg.end, seg.start - s.end), default=None)
            seg.label = nearest.label if nearest else unknown_label(0)


# ---------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------


@dataclass
class Turn:
    """Consecutive segments of one speaker: the unit that gets text."""

    speaker: str
    segments: list[Segment]
    text: str = ""

    @property
    def start(self) -> float:
        return self.segments[0].start

    @property
    def end(self) -> float:
        return self.segments[-1].end


def group_turns(segments: list[Segment]) -> list[Turn]:
    turns: list[Turn] = []
    for seg in segments:
        last = turns[-1] if turns else None
        if last and last.speaker == seg.label and seg.end - last.start <= TURN_MAX_SECONDS:
            last.segments.append(seg)
        else:
            turns.append(Turn(seg.label or unknown_label(0), [seg]))
    return turns


def transcribe_local(audio: np.ndarray, turns: list[Turn]) -> None:
    """SenseVoice on each turn's original audio, pauses included: on single VAD segments
    it splits Korean words apart ("결 정하 겠 습니다"), on whole turns it spaces them normally."""
    rec = recognizer()
    for turn in turns:
        s0 = max(0, int((turn.start - TURN_CONTEXT_SECONDS) * SAMPLE_RATE))
        s1 = min(len(audio), int((turn.end + TURN_CONTEXT_SECONDS) * SAMPLE_RATE))
        stream = rec.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio[s0:s1])
        rec.decode_stream(stream)
        turn.text = stream.result.text.strip()


def compact(audio: np.ndarray) -> bytes:
    """16 kHz mono Opus at 24 kbit/s (about 11 MB an hour), for uploads that must stay small."""
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1",
         "-i", "pipe:0", "-c:a", "libopus", "-b:a", "24k", "-f", "ogg", "pipe:1"],
        input=pcm, capture_output=True, check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise AudioError(f"오디오를 압축할 수 없습니다: {proc.stderr.decode(errors='ignore').strip()[:200]}")
    return proc.stdout


def transcribe_groq(audio: np.ndarray, data: bytes, filename: str, turns: list[Turn], language: str | None) -> None:
    """Whisper segments are put on the turn they overlap most."""
    if len(data) > GROQ_MAX_BYTES:  # the original file as uploaded (Open WebUI no longer re-encodes it)
        data, filename = compact(audio), "audio.ogg"
    form = {"model": GROQ_STT_MODEL, "response_format": "verbose_json", "language": language or STT_LANGUAGE}
    r = httpx.post(
        f"{GROQ_BASE_URL}/audio/transcriptions",
        headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
        data=form,
        files={"file": (filename or "audio", io.BytesIO(data))},
        timeout=httpx.Timeout(600.0, connect=10.0),
    )
    if r.status_code != 200:
        raise AudioError(f"Groq STT 오류 (HTTP {r.status_code}): {r.text[:300]}")
    for ws in r.json().get("segments", []):
        start, end, text = float(ws["start"]), float(ws["end"]), ws.get("text", "").strip()
        if not text or not turns:
            continue
        overlaps = [max(0.0, min(end, t.end) - max(start, t.start)) for t in turns]
        best = int(np.argmax(overlaps))
        if overlaps[best] == 0.0:  # in a gap between turns: nearest one
            best = int(np.argmin([min(abs(start - t.end), abs(end - t.start)) for t in turns]))
        turns[best].text = f"{turns[best].text} {text}".strip()


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

# One heavy job at a time: the VM has 4 vCPU / 4 GB shared with the whole stack.
_JOB_LOCK = threading.Lock()


def _clock(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


def transcribe(data: bytes, filename: str, voiceprints: list[Voiceprint], language: str | None = None) -> dict:
    with _JOB_LOCK:
        took = [time.monotonic()]
        audio = decode(data)
        duration = len(audio) / SAMPLE_RATE
        took.append(time.monotonic())
        segments = vad_segments(audio)
        took.append(time.monotonic())
        label_segments(segments, voiceprints)
        took.append(time.monotonic())
        groups = group_turns(segments)
        engine = stt_engine()
        if engine == "groq":
            transcribe_groq(audio, data, filename, groups, language)
        else:
            transcribe_local(audio, groups)
        took.append(time.monotonic())

    # Output lines: one per speaker change (turns split only by TURN_MAX_SECONDS are joined again).
    turns: list[dict] = []
    scores: list[list[float]] = []  # voiceprint scores of each line's segments
    for g in groups:
        if not g.text:
            continue
        if turns and turns[-1]["speaker"] == g.speaker:
            turns[-1]["text"] += " " + g.text
            turns[-1]["end"] = g.end
            scores[-1] += [s.score for s in g.segments]
        else:
            turns.append({"start": g.start, "end": g.end, "speaker": g.speaker, "text": g.text})
            scores.append([s.score for s in g.segments])
    for t, sc in zip(turns, scores):
        t["score"] = round(float(np.mean(sc)), 3) if sc else None
    speakers = sorted({t["speaker"] for t in turns})

    labelled = not (len(speakers) <= 1 and duration <= DICTATION_MAX_SECONDS)
    if not labelled:
        text = " ".join(t["text"] for t in turns)
    else:
        lines = ["(화자 자동 식별 transcript — '화자 A' · '화자 B' …는 목소리가 등록되지 않았거나 식별 신뢰도가 낮은 발언자이며, "
                 "같은 글자는 같은 목소리입니다)"]
        lines += [f"[{_clock(t['start'])}] {t['speaker']}: {t['text']}" for t in turns]
        text = "\n".join(lines) + "\n"

    log.info("transcribed %.1fs audio in %.1fs (decode %.1f, vad %.1f, speakers %.1f, text %.1f), engine=%s, threads=%d, "
             "%d segments, speakers=%s", duration, took[-1] - took[0], *(b - a for a, b in zip(took, took[1:])), engine,
             NUM_THREADS, len(segments), speakers)
    return {
        "text": text,
        "labelled": labelled,  # a meeting transcript (speaker lines), not chat-mic dictation
        "duration": round(duration, 2),
        "engine": engine,
        "speakers": speakers,
        "turns": [{**t, "start": round(t["start"], 2), "end": round(t["end"], 2)} for t in turns],
        "segments": [
            {"start": round(s.start, 2), "end": round(s.end, 2), "speaker": s.label, "score": round(s.score, 3)}
            for s in segments
        ],
    }
