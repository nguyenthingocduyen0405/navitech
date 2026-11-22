"""투자심의 보고서 (gateway/reports.py): Open WebUI 로그인 토큰 → 경영자문 Agent 권한 → backend POST /api/reports."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from gateway.audit import MemoryAuditLog
from test_desk import desk_app

TOKENS = {"t-ceo": "ceo@example.com", "t-staff": "staff@example.com", "t-secretary": "secretary@example.com"}
PDF = b"%PDF-1.7 report"


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
        if body["principal"]["clearance"] < 3:  # the report draws on a 대외비 meeting (backend's rule)
            return httpx.Response(404, json={"error": "보고서 'ADV-1'를 찾을 수 없거나 열람 권한이 없습니다."})
        return httpx.Response(200, content=PDF, headers={
            "content-type": "application/pdf", "content-disposition": "attachment; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf"})


@pytest.fixture
def reports():
    fake, audit = Fake(), MemoryAuditLog()
    with TestClient(desk_app(fake, audit)) as client:
        yield client, fake, audit


def post(client, token, body):
    return client.post("/meetings/reports", json=body, headers={"Authorization": f"Bearer {token}"} if token else {})


def test_a_report_opens_as_pdf_for_the_logged_in_user_and_is_audited(reports):
    client, fake, audit = reports
    resp = post(client, "t-ceo", {"system": "k_electronics", "id": "ADV-2026-11-22-02", "principal": {"email": "x@y", "clearance": 4}})
    assert resp.status_code == 200 and resp.content == PDF and resp.headers["content-type"] == "application/pdf"
    assert "filename*=UTF-8''" in resp.headers["content-disposition"] and resp.headers["cache-control"] == "no-store"
    path, body = fake.backend[-1]
    assert path == "/api/reports" and body["id"] == "ADV-2026-11-22-02" and body["system"] == "k_electronics"
    # the user comes from the login, signed — never from what the screen sent
    assert body["principal"]["email"] == "ceo@example.com" and body["principal"]["clearance"] == 4 and body["principal_token"]
    assert audit.entries[-1].query == "[보고서] k_electronics ADV-2026-11-22-02" and audit.entries[-1].agent == "advisory-agent"


def test_only_users_of_the_advisory_agent_may_open_reports(reports):
    client, fake, _ = reports
    assert post(client, None, {"id": "ADV-1"}).status_code == 401
    resp = post(client, "t-secretary", {"system": "group", "id": "ADV-1"})  # 간사: no advisory agent
    assert resp.status_code == 403 and "경영자문" in resp.json()["error"] and fake.backend == []


def test_the_backends_refusal_comes_back_as_it_is(reports):
    client, _, _ = reports
    resp = post(client, "t-staff", {"system": "k_electronics", "id": "ADV-1"})  # clearance 2: the backend hides it
    assert resp.status_code == 404 and "열람 권한" in resp.json()["error"]
    assert post(client, "t-ceo", {"system": "elsewhere", "id": "ADV-1"}).status_code == 400
    assert post(client, "t-ceo", {"system": "group"}).status_code == 400
