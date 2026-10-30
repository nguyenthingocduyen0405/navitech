"""회의 업무 화면 (gateway/desk.py): Open WebUI 로그인 토큰 → 권한 확인 → backend /api/desk/* 전달."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from gateway.audit import MemoryAuditLog
from gateway.main import create_app
from gateway.settings import Settings
from test_gateway import API_KEY, JWT_SECRET, PERMISSIONS_FILE, FakeDirectory

# Open WebUI 로그인 토큰 → 사용자 (가짜 /api/v1/auths/)
TOKENS = {"t-secretary": "secretary@example.com", "t-dev": "dev@example.com", "t-nogroup": "nogroup@example.com"}


class Fake:
    def __init__(self):
        self.backend: list[tuple[str, dict]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "open-webui":
            token = request.headers.get("authorization", "").removeprefix("Bearer ")
            if token not in TOKENS:
                return httpx.Response(401, json={"detail": "Not authenticated"})
            return httpx.Response(200, json={"email": TOKENS[token], "name": "사용자"})
        body = json.loads(request.content)
        self.backend.append((request.url.path, body))
        if request.url.path == "/api/desk/report" and body.get("meeting_id") == "MTG-2026-10-30-01":
            return httpx.Response(200, content=b"%PDF-1.7 fake", headers={
                "content-type": "application/pdf", "content-disposition": "attachment; filename*=UTF-8''%ED%9A%8C%EC%9D%98%EB%A1%9D.pdf"})
        return httpx.Response(200, json={"ok": True, "from": request.url.path})


@pytest.fixture
def desk():
    fake, audit = Fake(), MemoryAuditLog()
    settings = Settings(
        backend_api_key=API_KEY, owui_jwt_secret=JWT_SECRET, permissions_file=str(PERMISSIONS_FILE),
        app_database_url="unused", keycloak_url="unused", keycloak_realm="capstone", keycloak_client_id="gateway",
        keycloak_client_secret="unused", agent_backend_url="http://agents-group:8001", principal_signing_key="s" * 40,
    )
    app = create_app(settings, directory=FakeDirectory(), audit=audit, desk_transport=httpx.MockTransport(fake.handler))
    with TestClient(app) as client:
        yield client, fake, audit


def post(client, path, token, body=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.post(f"/meetings/api/{path}", json=body or {}, headers=headers)


def test_page_is_served(desk):
    client, _, _ = desk
    page = client.get("/meetings/")
    assert page.status_code == 200 and "회의 업무" in page.text
    assert client.get("/meetings/app.js").status_code == 200


def test_requests_go_to_the_backend_as_the_logged_in_user(desk):
    client, fake, audit = desk
    resp = post(client, "mail", "t-secretary", {"action": "resend", "mail_ids": ["MAIL-3"], "principal": {"email": "ceo@example.com"}})
    assert resp.status_code == 200 and resp.json()["from"] == "/api/desk/mail"
    path, body = fake.backend[0]
    assert body["action"] == "resend" and body["mail_ids"] == ["MAIL-3"]
    # 사용자는 화면이 보낸 값이 아니라 로그인으로 정해집니다 (서명 토큰 포함).
    assert body["principal"]["email"] == "secretary@example.com" and body["principal_token"]
    assert audit.entries[-1].query == "[회의 업무] mail resend ['MAIL-3']"
    post(client, "overview", "t-secretary")
    assert len(audit.entries) == 1  # 조회는 감사 로그에 남기지 않음


def test_documents_come_back_as_pdf_and_downloads_are_audited(desk):
    client, fake, audit = desk
    resp = post(client, "report", "t-secretary", {"meeting_id": "MTG-2026-10-30-01", "kind": "minutes"})
    assert resp.status_code == 200 and resp.headers["content-type"] == "application/pdf" and resp.content == b"%PDF-1.7 fake"
    assert "filename*=UTF-8''" in resp.headers["content-disposition"] and resp.headers["cache-control"] == "no-store"
    assert fake.backend[-1][1]["kind"] == "minutes"
    assert audit.entries[-1].query == "[회의 업무] report minutes MTG-2026-10-30-01"
    # 회의록이 없으면 backend의 {error} JSON이 그대로 갑니다.
    assert post(client, "report", "t-secretary", {"meeting_id": "MTG-X", "kind": "minutes"}).json()["from"] == "/api/desk/report"


def test_login_and_permission_are_required(desk):
    client, fake, _ = desk
    assert post(client, "overview", None).status_code == 401
    assert post(client, "overview", "t-expired").status_code == 401
    assert post(client, "overview", "t-nogroup").status_code == 403  # 회의지원 Agent 권한 없음
    assert post(client, "unknown", "t-secretary").status_code == 404
    assert fake.backend == []
    assert post(client, "overview", "t-dev").status_code == 200  # developer 그룹도 회의지원 Agent를 씀
