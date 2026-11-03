"""회의 업무 화면 (/meetings/): 회의 기록과 Agent가 보낸 메일을 목록으로 보고 Compliance 검토 · Action Item 완료 · 메일 다시 보내기를 직접 누르는 화면.

Open WebUI는 대화 화면뿐이라 따로 둡니다. nginx가 같은 도메인의 /meetings/를 gateway로 보내므로, 화면은
Open WebUI 로그인 토큰(localStorage.token)을 Authorization으로 보냅니다. gateway는 그 토큰으로 Open WebUI에
사용자를 묻고(/api/v1/auths/), 채팅과 같은 방식으로 Keycloak 그룹 → 권한을 정해 회의지원 Agent를 쓸 수 있는
사용자만 backend의 /api/desk/*로 넘깁니다 (principal + 서명 토큰). 버튼은 Agent(LLM)를 거치지 않습니다.

출석 확인: 녹음을 올린 화면이 출석 확인을 열면(checkin open) 응답에 QR(SVG)을 붙여 줍니다. QR은 휴대폰용 화면
/meetings/checkin/?c=코드&t=30초코드 를 가리키고, 휴대폰에서 같은 Open WebUI 로그인으로 출석합니다(checkin join).
출석은 회의지원 Agent 권한이 없어도 관리자가 그룹을 배정한 회사 계정이면 됩니다. 회의 카드에서 참석자를 고를 때는
디렉터리를 찾고(people), 고른 이메일은 여기서 회사 계정인지 확인한 뒤 이름 · Keycloak id와 함께 넘깁니다.
"""

import io
import logging
from pathlib import Path
from urllib.parse import urlencode

import httpx
import segno
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from agents.remote import principal, principal_token
from gateway.audit import AuditEntry, AuditLog
from gateway.auth import AuthError, build_user_context
from gateway.directory import Directory, DirectoryUnavailable
from gateway.permissions import Permissions
from gateway.settings import Settings

log = logging.getLogger("gateway.desk")

STATIC = Path(__file__).resolve().parent / "static" / "meetings"
ENDPOINTS = ("overview", "mail", "flags", "items", "meeting", "schedule", "report", "minutes", "checkin", "attendance", "people")
FIELDS = ("action", "view", "meeting_id", "mail_ids", "email", "note", "reviews", "item_id", "status",
          "title", "starts_at", "ends_at", "location", "attendees", "agenda", "classification", "kind", "owner", "due",
          "query", "offset", "code", "token", "voice_consent", "source_name", "speaker", "person")
READ_ACTIONS = ("list", None, "status")
PERMISSION = "meeting-agent"  # 회의지원 Agent를 쓸 수 있는 사용자만
TIMEOUT = httpx.Timeout(20.0, connect=5.0)
PEOPLE_LIMIT = 8


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


async def openwebui_user(settings: Settings, authorization: str | None, transport: httpx.AsyncBaseTransport | None = None) -> dict:
    """화면이 보낸 Open WebUI 로그인 토큰(Authorization) → 그 사용자 (Open WebUI /api/v1/auths/)."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AuthError(401, "Open WebUI에 로그인한 뒤 다시 열어 주세요.")
    async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport) as client:
        resp = await client.get(f"{settings.openwebui_internal_url}/api/v1/auths/", headers={"Authorization": authorization})
    if resp.status_code in (401, 403):
        raise AuthError(401, "로그인이 만료되었습니다. Open WebUI에 다시 로그인해 주세요.")
    resp.raise_for_status()
    user = resp.json()
    if not user.get("email"):
        raise AuthError(401, "사용자 정보를 확인할 수 없습니다.")
    return user


def checkin_link(base: str, code: str, token: str) -> str:
    return f"{base}/meetings/checkin/?{urlencode({'c': code, 't': token})}"


def qr_svg(text: str) -> str:
    """휴대폰 카메라로 찍을 QR (SVG 글자, 테두리 · 색은 화면이 정함)."""
    out = io.BytesIO()
    segno.make(text, error="m").save(out, kind="svg", scale=6, border=2, xmldecl=False, svgns=True, dark="#111", light="#fff")
    return out.getvalue().decode()


def register_desk(
    app: FastAPI,
    settings: Settings,
    directory: Directory,
    permissions: Permissions,
    audit: AuditLog,
    transport: httpx.AsyncBaseTransport | None = None,  # 테스트에서 가짜 Open WebUI · backend
) -> None:
    @app.post("/meetings/api/{endpoint}")
    async def desk(endpoint: str, request: Request):
        if endpoint not in ENDPOINTS:
            return _error(404, "Not Found")
        if endpoint == "checkin" and not settings.checkin_enabled:  # 화면(loader.js)은 실패하면 QR 없이 회의록만 만든다
            return _error(404, "출석 확인(QR)은 지금 꺼져 있습니다.")
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
        raw = await request.json() if await request.body() else {}
        if endpoint == "checkin" and raw.get("action") == "join":
            if not ctx.groups:  # 출석은 회사 계정이면 누구나 (회의지원 Agent 권한은 없어도 됨)
                return _error(403, "관리자가 등록한 회사 계정으로 로그인해야 출석할 수 있습니다.")
        elif not ctx.can_use(PERMISSION):
            return _error(403, "회의지원 Agent를 쓸 수 있는 사용자만 회의 업무 화면을 쓸 수 있습니다.")

        if endpoint == "people":  # 참석자 고르기: 회사 계정 찾기 (backend를 거치지 않음)
            try:
                found = await directory.find_people(str(raw.get("query") or ""), PEOPLE_LIMIT)
            except DirectoryUnavailable:
                log.exception("사용자 디렉터리 조회 실패")
                return _error(503, "사용자 디렉터리를 조회할 수 없습니다.")
            return JSONResponse({"people": [{"name": p.name, "email": p.email} for p in found]})

        body = {k: raw[k] for k in FIELDS if k in raw}  # 사용자는 화면이 아니라 로그인으로 정함
        person = body.get("person")
        if endpoint == "attendance" and isinstance(person, dict) and str(person.get("email") or "").strip():
            try:
                entry = await directory.lookup(str(person["email"]))
            except DirectoryUnavailable:
                return _error(503, "사용자 디렉터리를 조회할 수 없습니다.")
            if entry is None or not entry.groups:
                return _error(400, "회사 계정에서 찾을 수 없는 이메일입니다.")
            body["person"] = {"name": entry.name, "email": entry.email, "user_id": entry.user_id}
        elif "person" in body and not isinstance(person, dict):
            body.pop("person")
        body["principal"] = principal(ctx)
        if settings.principal_signing_key:
            body["principal_token"] = principal_token(ctx, settings.principal_signing_key)
        writes = body.get("item_id") or body.get("action") not in READ_ACTIONS
        if writes or endpoint == "report":  # 검토 · 완료 · 일정 · 메일 다시 보내기 · 취소 · 문서 내려받기는 감사 로그에 남김
            what = body.get("mail_ids") or body.get("meeting_id") or body.get("item_id") or body.get("code") or ""
            how = body.get("kind") if endpoint == "report" else body.get("action") or body.get("status")
            await audit.record(AuditEntry(email=ctx.email, agent=PERMISSION, allowed=True,
                                          query=f"[회의 업무] {endpoint} {how or ''} {what}".strip()))
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport) as client:
                resp = await client.post(f"{settings.agent_backend_url.rstrip('/')}/api/desk/{endpoint}", json=body)
        except httpx.HTTPError:
            log.exception("backend 회의 업무 호출 실패")
            return _error(503, "Agent backend에 연결할 수 없습니다.")
        if resp.status_code != 200:
            return _error(502 if resp.status_code >= 500 else resp.status_code, "회의 기록을 처리하지 못했습니다.")
        if resp.headers.get("content-type", "").startswith("application/pdf"):  # 회의록 · 결과 보고서
            return Response(resp.content, media_type="application/pdf", headers={
                "Content-Disposition": resp.headers.get("content-disposition", "attachment"), "Cache-Control": "no-store"})
        data = resp.json()
        if endpoint == "checkin" and data.get("token") and data.get("code"):  # 출석 QR (30초마다 바뀜)
            base = settings.public_url or str(request.base_url).rstrip("/")
            data["link"] = checkin_link(base, data["code"], data["token"])
            data["qr_svg"] = qr_svg(data["link"])
            data.pop("token")
        return JSONResponse(data)

    app.mount("/meetings", StaticFiles(directory=STATIC, html=True), name="meetings")
