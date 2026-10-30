import asyncio
import time
from pathlib import Path

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from gateway.audit import MemoryAuditLog
from gateway.directory import DirectoryPerson, DirectoryUser, KeycloakDirectory, name_keys
from gateway.main import create_app
from gateway.permissions import Permissions
from gateway.settings import Settings

API_KEY = "k" * 40
JWT_SECRET = "s" * 40
PERMISSIONS_FILE = Path(__file__).resolve().parents[1] / "config" / "permissions.yaml"

USERS = {
    "ceo@example.com": DirectoryUser("ceo@example.com", "CEO", frozenset({"executive"})),
    "secretary@example.com": DirectoryUser("secretary@example.com", "간사", frozenset({"secretary"})),
    "staff@example.com": DirectoryUser("staff@example.com", "실무자", frozenset({"staff"})),
    "dev@example.com": DirectoryUser("dev@example.com", "개발자", frozenset({"developer"})),
    "nogroup@example.com": DirectoryUser("nogroup@example.com", "No Group", frozenset()),
}


class FakeDirectory:
    async def lookup(self, email):
        return USERS.get(email)

    async def search_people(self, name):
        people = [DirectoryPerson("이서연", "seoyeon@example.com", "kc-1"), DirectoryPerson("박지훈", "jihoon@example.com", "kc-2")]
        return [p for p in people if p.name == name.replace(" ", "")]

    async def close(self):
        pass


@pytest.fixture
def audit():
    return MemoryAuditLog()


@pytest.fixture
def client(audit):
    settings = Settings(
        backend_api_key=API_KEY,
        owui_jwt_secret=JWT_SECRET,
        permissions_file=str(PERMISSIONS_FILE),
        app_database_url="unused",
        keycloak_url="unused",
        keycloak_realm="capstone",
        keycloak_client_id="gateway",
        keycloak_client_secret="unused",
    )
    app = create_app(settings, directory=FakeDirectory(), audit=audit)
    with TestClient(app) as c:
        yield c


def user_jwt(email, secret=JWT_SECRET, expires_in=300, issuer="open-webui"):
    now = int(time.time())
    payload = {"sub": "owui-id", "email": email, "name": email, "role": "user", "iss": issuer, "iat": now, "exp": now + expires_in}
    return jwt.encode(payload, secret, algorithm="HS256")


def chat(client, model, email=None, token=None, text="오늘 HBM 뉴스와 전략 시사점", stream=False, api_key=API_KEY):
    headers = {"Authorization": f"Bearer {api_key}"}
    if token or email:
        headers["X-OpenWebUI-User-Jwt"] = token or user_jwt(email)
    body = {"model": model, "messages": [{"role": "user", "content": text}], "stream": stream}
    return client.post("/v1/chat/completions", json=body, headers=headers)


def test_permissions_file_is_valid():
    perms = Permissions.load(PERMISSIONS_FILE)
    assert perms.resolve(["executive"])[0] == 4
    assert perms.resolve(["unknown-group"]) == (0, frozenset())


def test_models_require_api_key(client):
    assert client.get("/v1/models").status_code == 401
    resp = client.get("/v1/models", headers={"Authorization": f"Bearer {API_KEY}"})
    assert resp.status_code == 200
    assert {m["id"] for m in resp.json()["data"]} == {"super-agent", "advisory-agent", "news-agent", "meeting-agent"}


def test_wrong_api_key_rejected(client):
    assert chat(client, "news-agent", "ceo@example.com", api_key="x" * 40).status_code == 401


def test_missing_user_token_rejected(client):
    assert chat(client, "news-agent").status_code == 401


def test_forged_user_token_rejected(client):
    forged = user_jwt("ceo@example.com", secret="attacker-secret-" + "x" * 30)
    assert chat(client, "news-agent", token=forged).status_code == 401


def test_expired_user_token_rejected(client):
    expired = user_jwt("ceo@example.com", expires_in=-10)
    assert chat(client, "news-agent", token=expired).status_code == 401


def test_plain_user_headers_are_not_trusted(client):
    resp = client.post(
        "/v1/chat/completions",
        json={"model": "news-agent", "messages": [{"role": "user", "content": "hi"}]},
        headers={"Authorization": f"Bearer {API_KEY}", "X-OpenWebUI-User-Email": "ceo@example.com"},
    )
    assert resp.status_code == 401


def test_agent_not_permitted_is_403_and_audited(client, audit):
    resp = chat(client, "advisory-agent", "secretary@example.com")
    assert resp.status_code == 403
    assert audit.entries[-1].allowed is False
    assert audit.entries[-1].email == "secretary@example.com"


def test_user_without_groups_gets_nothing(client):
    for model in ("super-agent", "advisory-agent", "news-agent", "meeting-agent"):
        resp = chat(client, model, "nogroup@example.com")
        assert resp.status_code == 403
        assert "소속 그룹이 없어" in resp.json()["error"]["message"]


def test_developer_uses_every_agent_but_sees_only_public_documents(client, audit):
    for model in ("super-agent", "advisory-agent", "news-agent", "meeting-agent"):
        assert chat(client, model, "dev@example.com").status_code == 200
        assert audit.entries[-1].doc_ids == ["dart-2026-q2-report"]  # 공개 자료만


def test_direct_agent_call_filters_documents_by_clearance(client, audit):
    resp = chat(client, "news-agent", "staff@example.com")
    assert resp.status_code == 200
    answer = resp.json()["choices"][0]["message"]["content"]
    assert "ceo-strategy-memo" not in answer  # 극비 문서는 보이면 안 됨
    assert "board-meeting-2026-09" not in answer  # 대외비 문서도 보이면 안 됨
    assert audit.entries[-1].doc_ids == ["dart-2026-q2-report", "industry-hbm-trend"]


def test_executive_sees_top_secret(client, audit):
    resp = chat(client, "advisory-agent", "ceo@example.com")
    assert resp.status_code == 200
    assert "ceo-strategy-memo" in audit.entries[-1].doc_ids


def test_super_agent_cannot_be_used_to_bypass_agent_permissions(client):
    # "전략"은 advisory-agent로 라우팅되는데, 회의체 간사는 이 Agent를 직접 쓸 수 없습니다.
    resp = chat(client, "super-agent", "secretary@example.com", text="HBM 투자 전략 검토")
    assert resp.status_code == 200
    message = resp.json()["choices"][0]["message"]
    assert "경영자문 Agent · mock" not in message["content"]
    assert "사용 권한 없음" in message["reasoning_content"]


def test_super_agent_combines_several_agents(client, audit):
    resp = chat(client, "super-agent", "ceo@example.com", text="회의 안건 관련 뉴스와 전략")
    content = resp.json()["choices"][0]["message"]["content"]
    for label in ("경영자문 Agent", "뉴스 Briefing Agent", "회의지원 Agent"):
        assert label in content
    doc_ids = audit.entries[-1].doc_ids
    assert len(doc_ids) == len(set(doc_ids))  # 여러 Agent가 같은 문서를 인용해도 한 번만 기록


def test_streaming_response_is_openai_sse(client):
    resp = chat(client, "news-agent", "ceo@example.com", stream=True)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    lines = [line for line in resp.text.splitlines() if line.startswith("data: ")]
    assert lines[-1] == "data: [DONE]"
    assert '"reasoning_content"' in resp.text and '"content"' in resp.text


def test_internal_directory_lookup_needs_the_internal_key(audit):
    settings = Settings(
        backend_api_key=API_KEY,
        owui_jwt_secret=JWT_SECRET,
        permissions_file=str(PERMISSIONS_FILE),
        app_database_url="unused",
        keycloak_url="unused",
        keycloak_realm="capstone",
        keycloak_client_id="gateway",
        keycloak_client_secret="unused",
        internal_api_key="i" * 40,
    )
    with TestClient(create_app(settings, directory=FakeDirectory(), audit=audit)) as c:
        url = "/internal/directory/people"
        assert c.get(url, params={"name": "이서연"}).status_code == 401
        assert c.get(url, params={"name": "이서연"}, headers={"Authorization": f"Bearer {API_KEY}"}).status_code == 401
        found = c.get(url, params={"name": "이 서연"}, headers={"Authorization": "Bearer " + "i" * 40}).json()
        assert found == {"people": [{"name": "이서연", "email": "seoyeon@example.com", "sub": "kc-1"}]}


def test_mail_recipients_come_only_from_accounts_an_admin_assigned():
    # The meeting agent mails what this finds without approval: a self-registered account that took an
    # executive's name (no group) must not be found.
    users = [
        {"id": "kc-1", "username": "seoyeon", "firstName": "서연", "lastName": "이", "email": "seoyeon@example.com", "enabled": True},
        {"id": "kc-2", "username": "imposter", "firstName": "지훈", "lastName": "박", "email": "attacker@example.net", "enabled": True},
    ]
    groups = {"kc-1": [{"name": "executive"}], "kc-2": []}

    def keycloak(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 300})
        if request.url.path.endswith("/groups"):
            return httpx.Response(200, json=groups[request.url.path.split("/")[-2]])
        return httpx.Response(200, json=users)

    async def search(name):
        directory = KeycloakDirectory("http://kc", "capstone", "gateway", "x", transport=httpx.MockTransport(keycloak))
        try:
            return await directory.search_people(name)
        finally:
            await directory.close()

    assert asyncio.run(search("이서연")) == [DirectoryPerson("이 서연", "seoyeon@example.com", "kc-1")]
    assert asyncio.run(search("박지훈")) == []


def test_internal_api_is_closed_without_a_key(client):
    assert client.get("/internal/directory/people", params={"name": "이서연"}).status_code == 404


def test_people_are_found_by_korean_or_western_name_order():
    keys = name_keys("한율", "정", "hy0126")
    assert {"정한율", "한율정", "hy0126"} == keys
