"""회의 업무 화면 (gateway/desk.py): Open WebUI 로그인 토큰 → 권한 확인 → backend /api/desk/* 전달."""

import json
from urllib.parse import quote

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
        self.speech: list[tuple[str, str, dict, bytes, str]] = []  # (method, path, query, body, Authorization)

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "open-webui":
            token = request.headers.get("authorization", "").removeprefix("Bearer ")
            if token not in TOKENS:
                return httpx.Response(401, json={"detail": "Not authenticated"})
            return httpx.Response(200, json={"email": TOKENS[token], "name": "사용자"})
        if request.url.host == "speech-service":
            self.speech.append((request.method, request.url.path, dict(request.url.params), request.content,
                                request.headers.get("authorization", "")))
            if request.method == "POST":
                return httpx.Response(200, json={"job": "JOB123abc", "waiting": False})
            return httpx.Response(200, json={"status": "done", "filename": "x.m4a", "elapsed": 3.0, "result": {"turns": []}})
        body = json.loads(request.content)
        self.backend.append((request.url.path, body))
        if request.url.path == "/api/desk/checkin" and body.get("action") in ("open", "status"):
            return httpx.Response(200, json={"ok": True, "code": "CHK-ABC234", "token": "TOKEN123", "valid_for": 20, "open": True,
                                             "count": 0, "attendees": []})
        if request.url.path == "/api/desk/report" and body.get("meeting_id") == "MTG-2026-10-30-01":
            return httpx.Response(200, content=b"%PDF-1.7 fake", headers={
                "content-type": "application/pdf", "content-disposition": "attachment; filename*=UTF-8''%ED%9A%8C%EC%9D%98%EB%A1%9D.pdf"})
        return httpx.Response(200, json={"ok": True, "from": request.url.path})


def desk_app(fake, audit, **overrides):
    settings = Settings(
        backend_api_key=API_KEY, owui_jwt_secret=JWT_SECRET, permissions_file=str(PERMISSIONS_FILE),
        app_database_url="unused", keycloak_url="unused", keycloak_realm="capstone", keycloak_client_id="gateway",
        keycloak_client_secret="unused", agent_backend_url="http://agents-group:8001", principal_signing_key="s" * 40,
        public_url="https://navitech.example", speech_service_url="http://speech-service:8000", speech_api_key="speech-key",
        **overrides,
    )
    return create_app(settings, directory=FakeDirectory(), audit=audit, desk_transport=httpx.MockTransport(fake.handler))


@pytest.fixture
def desk():
    fake, audit = Fake(), MemoryAuditLog()
    with TestClient(desk_app(fake, audit)) as client:
        yield client, fake, audit


def post(client, path, token, body=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.post(f"/meetings/api/{path}", json=body or {}, headers=headers)


def test_page_is_served(desk):
    client, _, _ = desk
    page = client.get("/meetings/")
    assert page.status_code == 200 and "회의 업무" in page.text
    assert 'id="nv-desk"' in page.text and "/static/loader.js" in page.text  # 채팅의 회의 카드와 같은 코드가 그림


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


def test_minutes_search_goes_through_as_a_read(desk):
    client, fake, audit = desk
    assert post(client, "minutes", "t-secretary", {"query": "뉴로엣지", "status": "final", "offset": 15}).status_code == 200
    assert fake.backend[-1] == ("/api/desk/minutes", {**fake.backend[-1][1], "query": "뉴로엣지", "status": "final", "offset": 15})
    assert audit.entries == []  # 조회는 감사 로그에 남기지 않음


def test_closing_a_shaken_premise_is_a_write(desk):
    client, fake, audit = desk
    assert post(client, "watch", "t-secretary", {"action": "dismiss", "signal_id": "SIG-4", "note": "일시적"}).status_code == 200
    assert fake.backend[-1][0] == "/api/desk/watch" and fake.backend[-1][1]["signal_id"] == "SIG-4"
    assert audit.entries[-1].query == "[회의 업무] watch dismiss SIG-4"


def test_login_and_permission_are_required(desk):
    client, fake, _ = desk
    assert post(client, "overview", None).status_code == 401
    assert post(client, "overview", "t-expired").status_code == 401
    assert post(client, "overview", "t-nogroup").status_code == 403  # 회의지원 Agent 권한 없음
    assert post(client, "unknown", "t-secretary").status_code == 404
    assert fake.backend == []
    assert post(client, "overview", "t-dev").status_code == 200  # developer 그룹도 회의지원 Agent를 씀


def test_check_in_qr_points_at_the_phone_page_and_hides_the_raw_code(desk):
    client, fake, audit = desk
    out = post(client, "checkin", "t-secretary", {"action": "open", "source_name": "캡스톤_1030.m4a"}).json()
    assert out["link"] == "https://navitech.example/meetings/checkin/?c=CHK-ABC234&t=TOKEN123"
    assert out["qr_svg"].lstrip().startswith("<svg") and "token" not in out
    assert fake.backend[-1][1]["source_name"] == "캡스톤_1030.m4a"
    assert audit.entries[-1].query == "[회의 업무] checkin open CHK-ABC234" or audit.entries[-1].query.startswith("[회의 업무] checkin open")
    before = len(audit.entries)
    post(client, "checkin", "t-secretary", {"action": "status", "code": "CHK-ABC234"})
    assert len(audit.entries) == before  # 상태를 묻는 것은 감사 로그에 남기지 않음


def test_check_in_takes_the_account_and_its_keycloak_id_from_the_login(desk):
    client, fake, _ = desk
    resp = post(client, "checkin", "t-secretary", {"action": "join", "code": "CHK-ABC234", "token": "TOKEN123", "voice_consent": True,
                                                   "principal": {"email": "ceo@example.com"}})
    assert resp.status_code == 200
    body = fake.backend[-1][1]
    assert body["principal"]["email"] == "secretary@example.com" and body["principal"]["user_id"] == "kc-secretary"
    assert body["voice_consent"] is True and body["token"] == "TOKEN123"
    # 그룹이 없는 계정(관리자가 등록하지 않은 자가 가입)은 출석할 수 없습니다.
    assert post(client, "checkin", "t-nogroup", {"action": "join", "code": "CHK-ABC234", "token": "x"}).status_code == 403


def test_attendee_picker_finds_company_accounts_and_checks_the_chosen_email(desk):
    client, fake, _ = desk
    found = post(client, "people", "t-secretary", {"query": "example.com"}).json()["people"]
    assert {"name": "간사", "email": "secretary@example.com"} in found and all(p["email"] != "nogroup@example.com" for p in found)
    assert fake.backend == []  # backend를 거치지 않음
    post(client, "attendance", "t-secretary", {"action": "add", "meeting_id": "MTG-1", "person": {"name": "아무개", "email": "secretary@example.com"}})
    assert fake.backend[-1][1]["person"] == {"name": "간사", "email": "secretary@example.com", "user_id": "kc-secretary"}  # 이름은 계정의 이름
    bad = post(client, "attendance", "t-secretary", {"action": "add", "meeting_id": "MTG-1", "person": {"name": "외부", "email": "x@evil.example"}})
    assert bad.status_code == 400 and len(fake.backend) == 1
    post(client, "attendance", "t-secretary", {"action": "add", "meeting_id": "MTG-1", "person": {"name": "이름만"}})
    assert fake.backend[-1][1]["person"] == {"name": "이름만"}  # 이름만 고르면 그대로 (backend가 이름으로 찾음)


def test_the_check_in_page_is_served(desk):
    client, _, _ = desk
    page = client.get("/meetings/checkin/")
    assert page.status_code == 200 and "회의 출석" in page.text


def voice(token, filename="캡스톤 1030.m4a"):
    headers = {"X-Filename": quote(filename)}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def test_voice_check_sends_the_recording_as_the_logged_in_user(desk):
    client, fake, audit = desk
    resp = client.post("/meetings/api/voice-check", content=b"fake m4a bytes", headers=voice("t-secretary"))
    assert resp.status_code == 200 and resp.json()["job"] == "JOB123abc"
    method, path, query, body, key = fake.speech[-1]
    assert (method, path, body, key) == ("POST", "/internal/review", b"fake m4a bytes", "Bearer speech-key")
    assert query == {"owner": "secretary@example.com", "filename": "캡스톤 1030.m4a"}  # 결과를 볼 사람은 로그인으로 정함
    assert audit.entries[-1].query == "[회의 업무] voice-check 캡스톤 1030.m4a"
    client.post("/meetings/api/voice-check?method=pyannote", content=b"x", headers=voice("t-secretary", "a.m4a"))
    assert fake.speech[-1][2]["method"] == "pyannote" and audit.entries[-1].query == "[회의 업무] voice-check pyannote a.m4a"
    client.post("/meetings/api/voice-check?method=rm%20-rf", content=b"x", headers=voice("t-secretary", "a.m4a"))
    assert "method" not in fake.speech[-1][2]  # 정해진 방식만 넘김
    out = client.get("/meetings/api/voice-check/JOB123abc", headers=voice("t-secretary"))
    assert out.json()["status"] == "done" and fake.speech[-1][1:3] == ("/internal/review/JOB123abc", {"owner": "secretary@example.com"})
    assert len(audit.entries) == 3  # 결과를 묻는 것은 감사 로그에 남기지 않음
    assert fake.backend == []  # Agent backend를 거치지 않음


def test_voice_check_needs_the_meeting_agent_permission_and_a_sane_upload(desk, monkeypatch):
    client, fake, _ = desk
    assert client.post("/meetings/api/voice-check", content=b"x", headers=voice(None)).status_code == 401
    assert client.post("/meetings/api/voice-check", content=b"x", headers=voice("t-nogroup")).status_code == 403
    assert client.get("/meetings/api/voice-check/JOB123abc", headers=voice("t-nogroup")).status_code == 403
    assert client.get("/meetings/api/voice-check/x", headers=voice("t-secretary")).status_code == 404
    monkeypatch.setattr("gateway.voice_check.MAX_BYTES", 4)
    assert client.post("/meetings/api/voice-check", content=b"too long", headers=voice("t-secretary")).status_code == 413
    assert fake.speech == []
    page = client.get("/meetings/voice-check/")
    assert page.status_code == 200 and "목소리 구분 확인" in page.text and page.headers["cache-control"] == "no-store"


def test_check_in_can_be_turned_off():
    fake = Fake()
    with TestClient(desk_app(fake, MemoryAuditLog(), checkin_enabled=False)) as client:
        resp = post(client, "checkin", "t-secretary", {"action": "open", "source_name": "회의.m4a"})
        assert resp.status_code == 404 and "꺼져" in resp.json()["error"]  # 채팅 화면은 QR 없이 회의록만 만든다
        assert post(client, "overview", "t-secretary").status_code == 200  # 다른 회의 업무는 그대로
    assert [path for path, _ in fake.backend] == ["/api/desk/overview"]
