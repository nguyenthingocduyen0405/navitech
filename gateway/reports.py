"""투자심의 보고서 열람 · 내려받기 (POST /meetings/reports): 채팅의 보고서 카드(loader.js)가 부릅니다.

경영자문 Agent는 판단을 저장하고 보고서의 참조(id)만 돌려줍니다. 파일은 여기서 받을 때 backend가 저장된 판단으로 만듭니다.
화면이 보낸 Open WebUI 로그인 토큰으로 사용자를 확인하고(desk.py와 같은 방식), 경영자문 Agent를 쓸 수 있는 사용자만
Group backend의 POST /api/reports로 넘깁니다 (principal + 서명 토큰). K전자 보고서는 Group backend가 K전자에서 같은 사용자로
가져오므로 gateway는 Group backend만 부릅니다. 보고서가 인용한 회의를 볼 수 없는 사용자에게는 backend가 404를 돌려줍니다.
내려받기는 감사 로그에 남깁니다.

nginx가 /meetings/만 gateway로 보내므로 경로를 그 아래에 둡니다.
"""

import logging

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from agents.remote import principal, principal_token
from gateway.audit import AuditEntry, AuditLog
from gateway.auth import AuthError, build_user_context
from gateway.desk import openwebui_user
from gateway.directory import Directory, DirectoryUnavailable
from gateway.permissions import Permissions
from gateway.settings import Settings

log = logging.getLogger("gateway.reports")

PERMISSION = "advisory-agent"  # 보고서를 만든 Agent를 쓸 수 있는 사용자만
SYSTEMS = ("group", "k_electronics")
TIMEOUT = httpx.Timeout(60.0, connect=5.0)  # 보고서는 열 때 만듭니다 (K전자 보고서는 A2A를 한 번 더 거침)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def register_reports(
    app: FastAPI,
    settings: Settings,
    directory: Directory,
    permissions: Permissions,
    audit: AuditLog,
    transport: httpx.AsyncBaseTransport | None = None,  # 테스트에서 가짜 Open WebUI · backend
) -> None:
    @app.post("/meetings/reports")
    async def report(request: Request):
        if not settings.agent_backend_url:
            return _error(503, "Agent backend가 설정되지 않았습니다.")
        try:
            user = await openwebui_user(settings, request.headers.get("authorization"), transport)
        except AuthError as e:
            return _error(e.status_code, e.message)
        except httpx.HTTPError:
            log.exception("Open WebUI 사용자 확인 실패")
            return _error(503, "로그인 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.")
        try:
            ctx = await build_user_context({"email": user["email"], "name": user.get("name", "")}, directory, permissions)
        except DirectoryUnavailable:
            log.exception("사용자 디렉터리 조회 실패")
            return _error(503, "사용자 권한을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.")
        if not ctx.can_use(PERMISSION):
            return _error(403, "경영자문 Agent를 쓸 수 있는 사용자만 투자심의 보고서를 열 수 있습니다.")

        raw = await request.json() if await request.body() else {}
        report_id = str(raw.get("id") or "").strip()
        system = str(raw.get("system") or "group").strip()
        if not report_id or system not in SYSTEMS:
            return _error(400, "보고서 id와 system(group | k_electronics)이 필요합니다.")
        body = {"id": report_id, "system": system, "principal": principal(ctx)}  # 사용자는 화면이 아니라 로그인으로 정함
        if settings.principal_signing_key:
            body["principal_token"] = principal_token(ctx, settings.principal_signing_key)
        await audit.record(AuditEntry(email=ctx.email, agent=PERMISSION, allowed=True, query=f"[보고서] {system} {report_id}"))
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport) as client:
                resp = await client.post(f"{settings.agent_backend_url.rstrip('/')}/api/reports", json=body)
        except httpx.HTTPError:
            log.exception("backend 보고서 호출 실패")
            return _error(503, "Agent backend에 연결할 수 없습니다.")
        if resp.status_code == 200 and resp.headers.get("content-type", "").startswith("application/pdf"):
            return Response(resp.content, media_type="application/pdf", headers={
                "Content-Disposition": resp.headers.get("content-disposition", "attachment"), "Cache-Control": "no-store"})
        try:
            message = resp.json().get("error")
        except ValueError:
            message = None
        status = resp.status_code if resp.status_code in (401, 403, 404, 503) else 502
        return _error(status, message or "보고서를 가져오지 못했습니다.")
