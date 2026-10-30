"""Gateway → Agent backend 연동 (agents/remote.py). backend는 가짜 NDJSON 스트림으로 대신합니다."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from agents.remote import BACKEND_AGENTS, RemoteAgent, build_request
from gateway.audit import MemoryAuditLog
from gateway.main import create_app
from gateway.settings import Settings
from test_gateway import API_KEY, JWT_SECRET, PERMISSIONS_FILE, FakeDirectory, chat


def ndjson(*events) -> bytes:
    return "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events).encode()


def group(event: dict) -> dict:
    return {"system": "group", "origin": "direct", "run_id": "r1", **event}


def k(event: dict) -> dict:
    return {"system": "k_electronics", "origin": "a2a", "run_id": "r2", "relayed": True, **event}


# Group Super가 한 문장 쓰고 K전자에 A2A로 요청 → K Super가 뉴스 에이전트에 위임 → 최종 판단
SUPER_RUN = ndjson(
    group({"type": "agent_start", "agent": "group_super", "request": "q"}),
    group({"type": "agent_token", "agent": "group_super", "text": "K전자에 확인하겠습니다."}),
    group({"type": "a2a_start", "from": "group_super", "to": "k_super", "request": "뉴로엣지 검토"}),
    k({"type": "agent_start", "agent": "k_super", "request": "뉴로엣지 검토"}),
    k({"type": "agent_token", "agent": "k_super", "text": "K 내부 초안"}),
    k({"type": "delegation_start", "from": "k_super", "to": "news", "task": "리스크 조사"}),
    k({"type": "tool_start", "agent": "news", "tool": "run_company_risk_news_analysis", "args": {"company": "뉴로엣지"}}),
    k({"type": "tool_end", "agent": "news", "tool": "run_company_risk_news_analysis",
       "result": {"matched": 1, "risks": [{"source": {"id": "news-001"}}]}}),
    k({"type": "agent_end", "agent": "news", "response": "리스크 높음"}),
    k({"type": "delegation_end", "from": "k_super", "to": "news", "response": "리스크 높음"}),
    k({"type": "agent_end", "agent": "k_super", "response": "K 검토 결과"}),
    group({"type": "a2a_end", "from": "group_super", "to": "k_super", "response": "K 검토 결과"}),
    group({"type": "agent_token", "agent": "group_super", "text": "최종 "}),
    group({"type": "agent_token", "agent": "group_super", "text": "판단"}),
    group({"type": "agent_end", "agent": "group_super", "response": "최종 판단"}),
    group({"type": "done"}),
)


class FakeBackend:
    def __init__(self, body: bytes = SUPER_RUN, status_code: int = 200):
        self.body = body
        self.status_code = status_code
        self.requests: list[tuple[str, dict]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.url.path, json.loads(request.content)))
        return httpx.Response(self.status_code, content=self.body)


@pytest.fixture
def audit():
    return MemoryAuditLog()


def make_client(backend: FakeBackend, audit: MemoryAuditLog, handler=None) -> TestClient:
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
    transport = httpx.MockTransport(handler or backend.handler)
    agents = {a: RemoteAgent(a, a, "http://backend", transport=transport) for a in BACKEND_AGENTS}
    return TestClient(create_app(settings, directory=FakeDirectory(), audit=audit, agents=agents))


def test_super_agent_streams_own_answer_and_shows_handoffs_as_reasoning(audit):
    backend = FakeBackend()
    with make_client(backend, audit) as client:
        resp = chat(client, "super-agent", "ceo@example.com", text="뉴로엣지 인수 판단")
    message = resp.json()["choices"][0]["message"]
    # 답변은 Group Super 자신의 토큰만: K전자 내부 초안 · 전문 Agent 답변은 섞이지 않음
    assert message["content"] == "K전자에 확인하겠습니다.\n\n최종 판단"
    reasoning = message["reasoning_content"]
    assert "그룹 슈퍼에이전트 → K전자 슈퍼에이전트 A2A 요청: 뉴로엣지 검토" in reasoning
    assert "K전자 뉴스 에이전트" in reasoning and "run_company_risk_news_analysis" in reasoning
    assert audit.entries[-1].doc_ids == ["k_electronics/news-001"]
    principal = {"email": "ceo@example.com", "name": "CEO", "groups": ["executive"], "clearance": 4,
                 "agents": ["advisory", "meeting", "news"]}
    assert backend.requests == [("/api/agents/group-super/run", {"request": "뉴로엣지 인수 판단", "principal": principal})]


def test_streaming_is_openai_sse(audit):
    with make_client(FakeBackend(), audit) as client:
        resp = chat(client, "super-agent", "ceo@example.com", stream=True)
    lines = [line for line in resp.text.splitlines() if line.startswith("data: ")]
    assert lines[-1] == "data: [DONE]"
    assert '"reasoning_content"' in resp.text and "최종 " in resp.text


def test_specialist_routes_to_its_backend_endpoint(audit):
    body = ndjson(
        group({"type": "agent_token", "agent": "meeting", "text": "회의 요약"}),
        group({"type": "agent_end", "agent": "meeting", "response": "회의 요약"}),
        group({"type": "done"}),
    )
    backend = FakeBackend(body)
    with make_client(backend, audit) as client:
        resp = chat(client, "meeting-agent", "staff@example.com")
    assert resp.json()["choices"][0]["message"]["content"] == "회의 요약"
    assert backend.requests[0][0] == "/api/agents/meeting/run"
    # The backend's tools filter records by this user, never by anything the model says.
    assert backend.requests[0][1]["principal"] == {"email": "staff@example.com", "name": "실무자", "groups": ["staff"], "clearance": 2,
                                                   "agents": ["advisory", "meeting", "news"]}


def test_answer_without_tokens_uses_agent_end(audit):
    body = ndjson(group({"type": "agent_end", "agent": "news", "response": "전체 답변"}), group({"type": "done"}))
    with make_client(FakeBackend(body), audit) as client:
        resp = chat(client, "news-agent", "ceo@example.com")
    assert resp.json()["choices"][0]["message"]["content"] == "전체 답변"


def test_super_agent_cannot_delegate_to_agent_the_user_may_not_use(audit):
    # 회의체 간사는 경영자문 Agent를 쓸 수 없습니다 → backend가 위임하는 순간 중단
    body = ndjson(
        group({"type": "delegation_start", "from": "group_super", "to": "advisory", "task": "인수 검토"}),
        group({"type": "agent_end", "agent": "advisory", "response": "극비 검토 결과"}),
        group({"type": "agent_token", "agent": "group_super", "text": "최종 판단"}),
        group({"type": "done"}),
    )
    with make_client(FakeBackend(body), audit) as client:
        resp = chat(client, "super-agent", "secretary@example.com")
    message = resp.json()["choices"][0]["message"]
    assert "권한이 없습니다" in message["content"]
    assert "최종 판단" not in message["content"]
    assert "사용 권한 없음" in message["reasoning_content"]


def test_super_agent_answers_without_a_specialist_the_backend_skipped(audit):
    # backend가 principal.agents를 보고 경영자문 위임을 건너뛰면, 답변은 끊기지 않고 건너뛴 사실만 보입니다.
    body = ndjson(
        group({"type": "delegation_skipped", "from": "group_super", "to": "advisory", "reason": "permission"}),
        group({"type": "agent_token", "agent": "group_super", "text": "회의 기준만 정리했습니다."}),
        group({"type": "agent_end", "agent": "group_super", "response": "회의 기준만 정리했습니다."}),
        group({"type": "done"}),
    )
    backend = FakeBackend(body)
    with make_client(backend, audit) as client:
        resp = chat(client, "super-agent", "secretary@example.com")
    message = resp.json()["choices"][0]["message"]
    assert message["content"] == "회의 기준만 정리했습니다."
    assert "그룹 경영자문 에이전트: 사용 권한 없음 → 건너뜀" in message["reasoning_content"]
    assert backend.requests[0][1]["principal"]["agents"] == ["meeting", "news"]


def test_relayed_delegation_is_checked_too(audit):
    body = ndjson(
        k({"type": "delegation_start", "from": "k_super", "to": "advisory", "task": "CFO 검토"}),
        group({"type": "agent_token", "agent": "group_super", "text": "최종 판단"}),
        group({"type": "done"}),
    )
    with make_client(FakeBackend(body), audit) as client:
        resp = chat(client, "super-agent", "secretary@example.com")
    assert "최종 판단" not in resp.json()["choices"][0]["message"]["content"]


def test_backend_error_names_the_failing_agent(audit):
    body = ndjson(group({"type": "error", "agent": "k_super", "message": "LLM 오류"}))
    with make_client(FakeBackend(body), audit) as client:
        resp = chat(client, "super-agent", "ceo@example.com")
    assert "K전자 슈퍼에이전트: LLM 오류" in resp.json()["choices"][0]["message"]["content"]


def test_backend_rejection_and_unreachable_backend(audit):
    with make_client(FakeBackend(b"", status_code=500), audit) as client:
        resp = chat(client, "news-agent", "ceo@example.com")
    assert "HTTP 500" in resp.json()["choices"][0]["message"]["content"]

    def down(_request):
        raise httpx.ConnectError("refused")

    with make_client(FakeBackend(), audit, handler=down) as client:
        resp = chat(client, "news-agent", "ceo@example.com")
    assert "연결할 수 없습니다" in resp.json()["choices"][0]["message"]["content"]


def test_truncated_stream_is_reported(audit):
    body = ndjson(group({"type": "agent_token", "agent": "news", "text": "중간까지"}))
    with make_client(FakeBackend(body), audit) as client:
        resp = chat(client, "news-agent", "ceo@example.com")
    assert "완료 신호 없이" in resp.json()["choices"][0]["message"]["content"]


def test_build_request_keeps_recent_history_without_reasoning_blocks():
    messages = [
        {"role": "system", "content": "무시"},
        {"role": "user", "content": "뉴로엣지 인수 검토해줘"},
        {"role": "assistant", "content": '<details type="reasoning">생각</details>\n본실사 진입 권고'},
        {"role": "user", "content": [{"type": "text", "text": "CFO 관점에서 다시"}]},
    ]
    request = build_request(messages)
    assert request == (
        "[이전 대화]\n사용자: 뉴로엣지 인수 검토해줘\nAI: 본실사 진입 권고\n\n[현재 요청]\nCFO 관점에서 다시"
    )
    assert build_request(messages[-1:]) == "CFO 관점에서 다시"


def test_principal_is_signed_when_a_key_is_set():
    import asyncio

    import jwt as pyjwt

    from shared.user_context import UserContext

    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, content=ndjson(group({"type": "agent_end", "agent": "meeting", "response": "ok"}),
                                                  group({"type": "done"})))

    key = "z" * 40
    ctx = UserContext(email="staff@example.com", name="실무자", groups=frozenset({"staff"}), clearance=2,
                      allowed_agents=frozenset({"meeting-agent"}))

    def call(agent):
        async def run():
            return [e async for e in agent.run([{"role": "user", "content": "내 할 일"}], ctx)]

        return asyncio.run(run())

    call(RemoteAgent("meeting-agent", "회의지원", "http://backend", transport=httpx.MockTransport(handler), signing_key=key))
    claims = pyjwt.decode(seen[0]["principal_token"], key, algorithms=["HS256"], audience="navitech-agents",
                          issuer="navitech-gateway")
    assert claims["sub"] == "staff@example.com" and claims["groups"] == ["staff"] and claims["clearance"] == 2
    assert claims["agents"] == ["meeting"]
    assert claims["exp"] - claims["iat"] == 1800
    call(RemoteAgent("meeting-agent", "회의지원", "http://backend", transport=httpx.MockTransport(handler)))
    assert "principal_token" not in seen[1]


def test_every_agent_runs_on_the_group_system():
    from agents.registry import build_registry

    agents = build_registry({a: a for a in BACKEND_AGENTS}, "http://agents-group:8001")
    assert set(agents) == {"super-agent", "advisory-agent", "news-agent", "meeting-agent"}
    assert {a.base_url for a in agents.values()} == {"http://agents-group:8001"}
