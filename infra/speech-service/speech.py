"""Audio → speaker-labelled transcript.

    decode (ffmpeg, 16 kHz mono)
      → VAD segments (silero)                      speech turns, independent of the STT engine
      → speaker embedding per segment (CAM++)      compared with the enrolled voiceprints
      → text: local SenseVoice per segment, or Groq Whisper (segments mapped onto the VAD turns)
      → consecutive segments of one speaker merged into one line

Speaker decisions are always made on the VAD segments, so the STT engine only supplies text.
Segments shorter than MIN_EMBED_SECONDS carry too little voice to identify and take their
neighbour's label. Segments below the match threshold become "미확인 화자 N", clustered
among themselves so one unknown voice keeps one number.
"""

from __future__ import annotations

import io
import logging
import os
import subprocess
import threading
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

# Cosine score needed to put an enrolled name on a segment (calibrate with real voices).
MATCH_THRESHOLD = float(os.environ.get("VOICE_MATCH_THRESHOLD", "0.5"))
# Unknown segments at least this similar share one "미확인 화자 N".
UNKNOWN_CLUSTER_THRESHOLD = float(os.environ.get("UNKNOWN_CLUSTER_THRESHOLD", "0.5"))
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
STT_LANGUAGE = os.environ.get("STT_LANGUAGE", "ko")

UNKNOWN = "미확인 화자"


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
    """Any container/codec ffmpeg reads → float32 mono 16 kHz."""
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1"],
        input=data, capture_output=True, check=False,
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


def label_segments(segments: list[Segment], voiceprints: list[Voiceprint]) -> None:
    unknown_centroids: list[np.ndarray] = []
    for seg in segments:
        if seg.duration < MIN_EMBED_SECONDS:
            continue
        seg.embedding = embed(seg.samples)
        ranked = identify(seg.embedding, voiceprints)
        if ranked and ranked[0][1] >= MATCH_THRESHOLD:
            seg.label, seg.score = ranked[0][0].label, ranked[0][1]
            continue
        seg.score = ranked[0][1] if ranked else 0.0
        sims = [float(c @ seg.embedding) for c in unknown_centroids]
        if sims and max(sims) >= UNKNOWN_CLUSTER_THRESHOLD:
            k = int(np.argmax(sims))
            merged = unknown_centroids[k] + seg.embedding
            unknown_centroids[k] = merged / (np.linalg.norm(merged) or 1.0)
        else:
            unknown_centroids.append(seg.embedding)
            k = len(unknown_centroids) - 1
        seg.label = f"{UNKNOWN} {k + 1}"
    # Too short to identify: take the speaker of the closest identified segment in time.
    identified = [s for s in segments if s.label]
    for seg in segments:
        if seg.label is None:
            nearest = min(identified, key=lambda s: max(s.start - seg.end, seg.start - s.end), default=None)
            seg.label = nearest.label if nearest else f"{UNKNOWN} 1"


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
            turns.append(Turn(seg.label or f"{UNKNOWN} 1", [seg]))
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


def transcribe_groq(data: bytes, filename: str, turns: list[Turn], language: str | None) -> None:
    """Whisper segments are put on the turn they overlap most."""
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
        audio = decode(data)
        duration = len(audio) / SAMPLE_RATE
        segments = vad_segments(audio)
        label_segments(segments, voiceprints)
        groups = group_turns(segments)
        engine = stt_engine()
        if engine == "groq":
            transcribe_groq(data, filename, groups, language)
        else:
            transcribe_local(audio, groups)

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
        lines = ["(화자 자동 식별 transcript — '미확인 화자'는 등록되지 않은 목소리이거나 식별 신뢰도가 낮은 구간입니다)"]
        lines += [f"[{_clock(t['start'])}] {t['speaker']}: {t['text']}" for t in turns]
        text = "\n".join(lines) + "\n"

    log.info("transcribed %.1fs audio, engine=%s, %d segments, speakers=%s", duration, engine, len(segments), speakers)
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
