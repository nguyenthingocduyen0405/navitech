"""회의 관제에서 녹음 받기 (/meetings/api/recording/*): 회의가 끝나면 그 회의 칸에 녹음을 놓고, 진행을 그 자리에서 본다.

  transcribe  녹음 파일 그대로를 본문으로 (파일 이름은 X-Filename, URI 인코딩) → speech-service /v1/audio/transcriptions
              (채팅의 음성 받아쓰기와 같은 길: 발언자 식별 · transcript id 보관) → {transcript_id, seconds, speakers, lines, text}
  minutes     {meeting_id, filename, text} → 회의지원 Agent에게 채팅과 같은 요청("회의 녹음 파일을 올렸습니다 … 회의: id")을 보내고,
              Agent가 하는 일(교정 · 저장 …)을 한 줄씩 흘려보낸다 (NDJSON: {"type": "status" | "text" | "done", "text"})

권한은 회의 업무 화면과 같다 (Open WebUI 로그인 · 회의지원 Agent 권한). 확정 · 메일은 desk의 finalize (사람이 누름).
"""

import json
import logging
import re
from urllib.parse import unquote

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from agents.base import Agent
from gateway.audit import AuditEntry, AuditLog
from gateway.auth import AuthError, build_user_context
from gateway.desk import PERMISSION, openwebui_user
from gateway.directory import Directory, DirectoryUnavailable
from gateway.permissions import Permissions
from gateway.settings import Settings
from shared.user_context import UserContext

log = logging.getLogger("gateway.recording")

MAX_BYTES = 200 * 1024 * 1024  # nginx client_max_body_size와 같게
STT_TIMEOUT = httpx.Timeout(600.0, connect=5.0)  # 긴 회의는 글로 옮기는 데 몇 분 걸림
MEETING_ID = re.compile(r"^MTG-[0-9A-Z-]{6,30}$")
MAX_TEXT = 400_000
_SPEAKER = re.compile(r"^\[\d{2}:\d{2}(?::\d{2})?\] ([^:]+):", re.M)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def minutes_request(meeting_id: str, filename: str, text: str) -> str:
    """채팅에서 녹음을 올렸을 때 loader.js가 보내는 요청과 같은 말 + 첨부(transcript) 내용."""
    return (f"회의 녹음 파일을 올렸습니다. 첨부한 녹음의 transcript로 회의록 초안을 작성해 주세요. 녹음 파일: {filename} · 회의: {meeting_id}"
            f"\n\n[첨부 파일 내용]\n{text}")


def register_recording(
    app: FastAPI,
    settings: Settings,
    directory: Directory,
    permissions: Permissions,
    audit: AuditLog,
    agents: dict[str, Agent],
    transport: httpx.AsyncBaseTransport | None = None,  # 테스트에서 가짜 Open WebUI · speech-service
) -> None:
    async def allowed_user(request: Request) -> tuple[UserContext | None, JSONResponse | None]:
        try:
            user = await openwebui_user(settings, request.headers.get("authorization"), transport)
            ctx = await build_user_context({"email": user["email"], "name": user.get("name", "")}, directory, permissions)
        except AuthError as e:
            return None, _error(e.status_code, e.message)
        except (httpx.HTTPError, DirectoryUnavailable):
            log.exception("사용자 확인 실패")
            return None, _error(503, "로그인 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.")
        if not ctx.can_use(PERMISSION):
            return None, _error(403, "회의지원 Agent를 쓸 수 있는 사용자만 회의 녹음을 올릴 수 있습니다.")
        return ctx, None

    @app.post("/meetings/api/recording/transcribe")
    async def transcribe(request: Request):
        if not settings.speech_service_url:
            return _error(503, "음성 서비스가 설정되지 않았습니다.")
        ctx, error = await allowed_user(request)
        if error:
            return error
        data = await request.body()
        if not data:
            return _error(411, "녹음 파일이 비어 있습니다.")
        if len(data) > MAX_BYTES:
            return _error(413, f"녹음 파일은 {MAX_BYTES // 2**20}MB까지 올릴 수 있습니다.")
        filename = unquote(request.headers.get("x-filename") or "audio").strip()[:200] or "audio"
        meeting_id = request.query_params.get("meeting_id") or ""
        await audit.record(AuditEntry(email=ctx.email, agent=PERMISSION, allowed=True,
                                      query=f"[회의 관제] 녹음 받기 {meeting_id} {filename}".strip()))
        headers = {"Authorization": f"Bearer {settings.speech_api_key}"} if settings.speech_api_key else {}
        try:
            async with httpx.AsyncClient(timeout=STT_TIMEOUT, transport=transport) as client:
                resp = await client.post(f"{settings.speech_service_url}/v1/audio/transcriptions", headers=headers,
                                         files={"file": (filename, data, request.headers.get("content-type") or "application/octet-stream")})
        except httpx.HTTPError:
            log.exception("speech-service 받아쓰기 실패")
            return _error(503, "음성 서비스에 연결할 수 없습니다.")
        if resp.status_code != 200:
            message = (resp.json().get("error") or {}).get("message") if resp.headers.get("content-type", "").startswith("application/json") else None
            return _error(502, message or "녹음을 글로 옮기지 못했습니다.")
        out = resp.json()
        text = out.get("text") or ""
        speakers = list(dict.fromkeys(_SPEAKER.findall(text)))
        return JSONResponse({"transcript_id": out.get("transcript_id"), "seconds": round(out.get("duration") or 0),
                             "speakers": speakers, "lines": len(_SPEAKER.findall(text)), "text": text})

    @app.post("/meetings/api/recording/minutes")
    async def minutes(request: Request):
        ctx, error = await allowed_user(request)
        if error:
            return error
        raw = await request.json()
        meeting_id, filename, text = str(raw.get("meeting_id") or ""), str(raw.get("filename") or "audio")[:200], str(raw.get("text") or "")
        if not MEETING_ID.match(meeting_id):
            return _error(400, "회의 id가 올바르지 않습니다.")
        if not text.strip() or len(text) > MAX_TEXT:
            return _error(400, "transcript가 비었거나 너무 깁니다.")
        agent = agents.get(PERMISSION)
        if agent is None:
            return _error(503, "회의지원 Agent가 설정되지 않았습니다.")
        await audit.record(AuditEntry(email=ctx.email, agent=PERMISSION, allowed=True, query=f"[회의 관제] 회의록 초안 {meeting_id} {filename}"))

        async def lines():
            try:
                async for event in agent.run([], ctx, task=minutes_request(meeting_id, filename, text)):
                    if event.type in ("status", "text") and event.content:
                        yield json.dumps({"type": event.type, "text": event.content}, ensure_ascii=False) + "\n"
            except Exception:  # 화면에는 실패만 알린다 (자세한 것은 로그)
                log.exception("회의 관제 회의록 요청 실패")
                yield json.dumps({"type": "error", "text": "회의록 초안을 만들지 못했습니다."}, ensure_ascii=False) + "\n"
            yield json.dumps({"type": "done"}) + "\n"

        return StreamingResponse(lines(), media_type="application/x-ndjson")
