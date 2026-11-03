"""목소리 구분 확인 화면 (/meetings/voice-check/): 지금 쓰는 모델이 회의 녹음의 발언자를 얼마나 잘 나누고 이름을 맞히는지
사람이 듣고 확인하는 화면. 녹음을 올리면 speech-service가 회의지원 채팅과 같은 방식(VAD → 목소리 묶기 → 등록된 voiceprint와
비교 → 글자)으로 처리하고, 화면은 왼쪽에 녹음 · 발언자 요약, 오른쪽에 '이름: 발언'을 보여 준다.

확인용이라 transcript로 보관하지 않고 목소리도 익히지 않는다 (결과는 speech-service 메모리에 1시간, 올린 사람만 봄).
이름이 붙은 transcript를 받는 범위가 채팅과 같도록 회의지원 Agent 권한이 있는 사용자만 쓰고, 올린 일은 감사 로그에 남긴다.
1시간 녹음에 2분쯤 걸려 요청 하나로 기다리지 않는다: 올리면 job id를 받고, 화면이 그 id로 결과를 묻는다 (nginx 시간 제한).
"""

import logging
import re
from pathlib import Path
from urllib.parse import unquote

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

from gateway.audit import AuditEntry, AuditLog
from gateway.auth import AuthError, build_user_context
from gateway.desk import PERMISSION, openwebui_user
from gateway.directory import Directory, DirectoryUnavailable
from gateway.permissions import Permissions
from gateway.settings import Settings
from shared.user_context import UserContext

log = logging.getLogger("gateway.voice_check")

PAGE = Path(__file__).resolve().parent / "static" / "meetings" / "voice-check" / "index.html"
MAX_BYTES = 200 * 1024 * 1024  # nginx client_max_body_size와 같게
JOB_ID = re.compile(r"^[A-Za-z0-9_-]{8,40}$")
METHODS = ("vad", "pyannote")  # 발언자를 나누는 방식 (speech-service speech.DIARIZATION)
UPLOAD_TIMEOUT = httpx.Timeout(120.0, connect=5.0)
STATUS_TIMEOUT = httpx.Timeout(30.0, connect=5.0)  # 화자 분리 중에는 speech-service가 늦게 답할 때가 있음


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _relay(resp: httpx.Response) -> JSONResponse:
    """speech-service의 응답: 성공과 사용자에게 보일 오류({error})는 그대로, 그 밖의 실패는 502."""
    try:
        data = resp.json()
    except ValueError:
        data = {}
    if resp.status_code == 200:
        return JSONResponse(data)
    if resp.status_code in (400, 404, 429) and data.get("error"):
        return _error(resp.status_code, data["error"])
    log.warning("speech-service 응답 %s: %s", resp.status_code, resp.text[:200])
    return _error(502, "음성 서비스가 녹음을 처리하지 못했습니다.")


def register_voice_check(
    app: FastAPI,
    settings: Settings,
    directory: Directory,
    permissions: Permissions,
    audit: AuditLog,
    transport: httpx.AsyncBaseTransport | None = None,  # 테스트에서 가짜 Open WebUI · speech-service
) -> None:
    async def allowed_user(request: Request) -> tuple[UserContext | None, JSONResponse | None]:
        if not settings.speech_service_url:
            return None, _error(503, "음성 서비스가 설정되지 않았습니다.")
        try:
            user = await openwebui_user(settings, request.headers.get("authorization"), transport)
            ctx = await build_user_context({"email": user["email"], "name": user.get("name", "")}, directory, permissions)
        except AuthError as e:
            return None, _error(e.status_code, e.message)
        except (httpx.HTTPError, DirectoryUnavailable):
            log.exception("사용자 확인 실패")
            return None, _error(503, "로그인 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.")
        if not ctx.can_use(PERMISSION):
            return None, _error(403, "회의지원 Agent를 쓸 수 있는 사용자만 목소리 구분을 확인할 수 있습니다.")
        return ctx, None

    @app.get("/meetings/voice-check/")
    async def page():
        """화면을 고치면 바로 보이도록 브라우저가 저장해 두지 않게 (나머지 /meetings/ 정적 파일은 desk의 mount)."""
        return FileResponse(PAGE, headers={"Cache-Control": "no-store"})

    def speech_headers() -> dict[str, str]:
        return {"Authorization": f"Bearer {settings.speech_api_key}"} if settings.speech_api_key else {}

    @app.post("/meetings/api/voice-check")
    async def upload(request: Request):
        """녹음 파일 그대로를 본문으로 (파일 이름은 X-Filename, URI 인코딩, 나누는 방식은 ?method=) → {job}."""
        ctx, error = await allowed_user(request)
        if error:
            return error
        size = int(request.headers.get("content-length") or 0)
        if size <= 0:
            return _error(411, "녹음 파일이 비어 있습니다.")
        if size > MAX_BYTES:
            return _error(413, f"녹음 파일은 {MAX_BYTES // 2**20}MB까지 올릴 수 있습니다.")
        filename = unquote(request.headers.get("x-filename") or "audio").strip()[:200] or "audio"
        params = {"owner": ctx.email, "filename": filename}
        if request.query_params.get("method") in METHODS:
            params["method"] = request.query_params["method"]
        await audit.record(AuditEntry(email=ctx.email, agent=PERMISSION, allowed=True,
                                      query=" ".join(filter(None, ["[회의 업무] voice-check", params.get("method"), filename]))))
        try:
            async with httpx.AsyncClient(timeout=UPLOAD_TIMEOUT, transport=transport) as client:
                resp = await client.post(
                    f"{settings.speech_service_url}/internal/review",
                    params=params,
                    headers={**speech_headers(), "Content-Type": "application/octet-stream", "Content-Length": str(size)},
                    content=request.stream(),  # 녹음을 gateway 메모리에 모으지 않고 흘려보냄
                )
        except httpx.HTTPError:
            log.exception("speech-service 업로드 실패")
            return _error(503, "음성 서비스에 연결할 수 없습니다.")
        return _relay(resp)

    @app.get("/meetings/api/voice-check/{job}")
    async def result(job: str, request: Request):
        ctx, error = await allowed_user(request)
        if error:
            return error
        if not JOB_ID.match(job):
            return _error(404, "결과가 없습니다.")
        try:
            async with httpx.AsyncClient(timeout=STATUS_TIMEOUT, transport=transport) as client:
                resp = await client.get(f"{settings.speech_service_url}/internal/review/{job}",
                                        params={"owner": ctx.email}, headers=speech_headers())
        except httpx.HTTPError:
            log.exception("speech-service 결과 조회 실패")
            return _error(503, "음성 서비스에 연결할 수 없습니다.")
        return _relay(resp)
