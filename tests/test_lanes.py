"""Lane: 같은 대화의 요청은 차례로, 전체 동시 실행 수는 한도까지 (gateway/lanes.py)."""

import asyncio
import json

import httpx
import pytest

from agents.base import AgentEvent
from gateway.audit import MemoryAuditLog
from gateway.lanes import WAIT_FULL, WAIT_SAME_CHAT, WAIT_TIMEOUT, Lanes, LaneTimeout, lane_key
from gateway.main import create_app
from gateway.recording import LANE_TIMEOUT_ERROR, WAIT_SAME_MEETING, with_keepalive
from gateway.settings import Settings
from test_gateway import API_KEY, JWT_SECRET, PERMISSIONS_FILE, FakeDirectory, user_jwt
from test_recording import Speech, app_with


class Run:
    """끝내라고 할 때까지 실행 중인 가짜 Agent 실행. 시작 · 끝을 log에 남깁니다."""

    def __init__(self, name: str, log: list[str], fail: bool = False):
        self.name, self.log, self.fail = name, log, fail
        self.finish = asyncio.Event()

    async def events(self):
        self.log.append(f"{self.name} start")
        yield AgentEvent.text(f"{self.name} 답변 시작")
        await self.finish.wait()
        if self.fail:
            raise RuntimeError("backend 끊김")
        self.log.append(f"{self.name} end")
        yield AgentEvent.text(f"{self.name} 답변 끝")


async def collect(stream, into: list | None = None):
    into = [] if into is None else into
    async for event in stream:
        into.append(event)
    return into


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


def start(lanes, key, run, into=None, **kw):
    return asyncio.create_task(collect(lanes.stream(key, run.events(), **kw), into))


def assert_empty(lanes):
    assert lanes._chats == {} and lanes._users == {}  # 끝난 lane은 남지 않음


# --- lanes.py --------------------------------------------------------------------------------------


def test_same_chat_waits_for_the_previous_run():
    async def scenario():
        lanes, log = Lanes(max_runs=4, wait_seconds=5), []
        a, b = Run("a", log), Run("b", log)
        got_b = []
        ta = start(lanes, "chat-1", a)
        await settle()
        tb = start(lanes, "chat-1", b, got_b)
        await settle()
        assert log == ["a start"] and got_b == [AgentEvent.status(WAIT_SAME_CHAT)]
        a.finish.set()
        await settle()
        assert log == ["a start", "a end", "b start"]
        b.finish.set()
        await asyncio.gather(ta, tb)
        assert [e.content for e in got_b[1:]] == ["b 답변 시작", "b 답변 끝"]
        assert_empty(lanes)

    asyncio.run(scenario())


def test_different_chats_run_at_the_same_time():
    async def scenario():
        lanes, log = Lanes(max_runs=4, wait_seconds=5), []
        a, b = Run("a", log), Run("b", log)
        tasks = [start(lanes, "chat-1", a), start(lanes, "chat-2", b)]
        await settle()
        assert log == ["a start", "b start"]
        a.finish.set(), b.finish.set()
        await asyncio.gather(*tasks)

    asyncio.run(scenario())


def test_runs_beyond_the_limit_wait_in_order():
    async def scenario():
        lanes, log = Lanes(max_runs=1, wait_seconds=5), []
        a, b, c = Run("a", log), Run("b", log), Run("c", log)
        got_b = []
        tasks = [start(lanes, "chat-1", a)]
        await settle()
        tasks.append(start(lanes, "chat-2", b, got_b))
        await settle()
        tasks.append(start(lanes, "chat-3", c))
        await settle()
        assert log == ["a start"] and got_b == [AgentEvent.status(WAIT_FULL)]
        a.finish.set()
        await settle()
        assert log == ["a start", "a end", "b start"]  # 먼저 온 b가 먼저
        b.finish.set(), c.finish.set()
        await asyncio.gather(*tasks)
        assert log == ["a start", "a end", "b start", "b end", "c start", "c end"]

    asyncio.run(scenario())


def test_a_same_chat_waiter_does_not_take_a_slot():
    async def scenario():
        lanes, log = Lanes(max_runs=2, wait_seconds=5), []
        a, b, c = Run("a", log), Run("b", log), Run("c", log)
        tasks = [start(lanes, "chat-1", a)]
        await settle()
        tasks.append(start(lanes, "chat-1", b))  # a를 기다림: 남은 자리 하나는 다른 대화 몫
        await settle()
        tasks.append(start(lanes, "chat-2", c))
        await settle()
        assert log == ["a start", "c start"]
        a.finish.set(), b.finish.set(), c.finish.set()
        await asyncio.gather(*tasks)
        assert_empty(lanes)

    asyncio.run(scenario())


def test_closed_stream_keeps_the_lane_until_the_run_ends():
    async def scenario():
        lanes, log, done = Lanes(max_runs=4, wait_seconds=5), [], []
        a, b = Run("a", log), Run("b", log)

        async def on_done():
            done.append("a")

        stream = lanes.stream("chat-1", a.events(), on_done=on_done)
        assert (await anext(stream)).content == "a 답변 시작"
        await stream.aclose()  # 사용자가 멈춤을 누름: backend는 a를 계속 실행
        tb = start(lanes, "chat-1", b)
        await settle()
        assert log == ["a start"] and done == []  # b는 a가 끝나기를 기다림
        a.finish.set()
        await settle()
        assert log == ["a start", "a end", "b start"] and done == ["a"]
        b.finish.set()
        await tb

    asyncio.run(scenario())


def test_wait_limit_raises_instead_of_running():
    async def scenario():
        lanes, log = Lanes(max_runs=4, wait_seconds=0.05), []
        a, b = Run("a", log), Run("b", log)
        ta = start(lanes, "chat-1", a)
        await settle()
        got_b = []
        with pytest.raises(LaneTimeout):
            await collect(lanes.stream("chat-1", b.events()), got_b)
        assert got_b == [AgentEvent.status(WAIT_SAME_CHAT)] and log == ["a start"]  # b는 실행되지 않음
        a.finish.set()
        await ta
        assert_empty(lanes)

    asyncio.run(scenario())


@pytest.mark.parametrize("how", ["timeout", "cancel"])
def test_a_wait_for_a_slot_that_ends_frees_its_chat(how):
    # chat-2 요청이 대화 lane을 얻은 뒤 빈자리를 기다리다 끝나면(한도 초과 · 떠남), chat-2를 쥔 채로 남으면 안 됨
    async def scenario():
        lanes, log = Lanes(max_runs=1, wait_seconds=0.05 if how == "timeout" else 5), []
        a, b, c = Run("a", log), Run("b", log), Run("c", log)
        ta = start(lanes, "chat-1", a)
        await settle()
        got_b = []
        tb = start(lanes, "chat-2", b, got_b)
        await settle()
        assert got_b == [AgentEvent.status(WAIT_FULL)]
        if how == "cancel":
            tb.cancel()
        with pytest.raises(LaneTimeout if how == "timeout" else asyncio.CancelledError):
            await tb
        a.finish.set()
        await ta
        c.finish.set()
        await collect(lanes.stream("chat-2", c.events()))
        assert log == ["a start", "a end", "c start", "c end"]
        assert_empty(lanes)

    asyncio.run(scenario())


def test_a_left_wait_for_a_slot_lets_the_next_message_of_that_chat_run():
    # chat-2의 b가 빈자리를 기다리는 동안 같은 대화의 d가 b 뒤에 섬 → b가 떠나면 d는 a가 끝난 뒤 바로 실행돼야 함
    async def scenario():
        lanes, log = Lanes(max_runs=1, wait_seconds=1), []
        a, b, d = Run("a", log), Run("b", log), Run("d", log)
        ta = start(lanes, "chat-1", a)
        await settle()
        tb = start(lanes, "chat-2", b)
        await settle()
        d.finish.set()
        td = start(lanes, "chat-2", d)
        await settle()
        tb.cancel()
        with pytest.raises(asyncio.CancelledError):
            await tb
        a.finish.set()
        await asyncio.gather(ta, td)  # b가 chat-2를 쥔 채로 남으면 d는 기다리다 LaneTimeout
        assert log == ["a start", "a end", "d start", "d end"]
        assert_empty(lanes)

    asyncio.run(scenario())


def test_cancelled_wait_for_the_chat_holds_nothing():
    async def scenario():
        lanes, log = Lanes(max_runs=1, wait_seconds=5), []
        a, b, c = Run("a", log), Run("b", log), Run("c", log)
        ta = start(lanes, "chat-1", a)
        await settle()
        tb = start(lanes, "chat-1", b)
        await settle()
        tb.cancel()  # 기다리던 사용자가 떠남
        with pytest.raises(asyncio.CancelledError):
            await tb
        a.finish.set()
        await ta
        c.finish.set()
        await collect(lanes.stream("chat-1", c.events()))
        assert log == ["a start", "a end", "c start", "c end"]
        assert_empty(lanes)

    asyncio.run(scenario())


def test_a_request_abandoned_while_waiting_does_not_run():
    async def scenario():
        lanes, log = Lanes(max_runs=4, wait_seconds=5), []
        a, b = Run("a", log), Run("b", log)
        ta = start(lanes, "chat-1", a)
        await settle()

        async def gone():
            return True

        b.finish.set()  # 실행되면 바로 끝나 log에 남음 (멈추지 않고 실패하게)
        tb = start(lanes, "chat-1", b, abandoned=gone)
        await settle()
        a.finish.set()
        await asyncio.gather(ta, tb)
        assert log == ["a start", "a end"]  # b는 자리를 얻었지만 요청한 쪽이 떠나 실행하지 않음
        assert_empty(lanes)

    asyncio.run(scenario())


def test_failed_run_reaches_the_reader_and_frees_the_lane():
    async def scenario():
        lanes, log = Lanes(max_runs=1, wait_seconds=5), []
        a = Run("a", log, fail=True)
        a.finish.set()
        with pytest.raises(RuntimeError, match="backend 끊김"):
            await collect(lanes.stream("chat-1", a.events()))
        b = Run("b", log)
        b.finish.set()
        await collect(lanes.stream("chat-1", b.events()))
        assert log == ["a start", "b start", "b end"]

    asyncio.run(scenario())


def test_lane_key_keeps_users_apart():
    assert lane_key("a@example.com", "local") != lane_key("b@example.com", "local")
    assert lane_key("a@example.com", None) == lane_key("a@example.com", "")


# --- gateway를 거친 채팅 --------------------------------------------------------------------------------


class TimedAgent:
    """질문(A, B …)마다 시작 · 끝을 log에 남기는 Agent. A는 답변 사이에 시간이 걸리고, 사용자가 떠난 뒤에 문서를 인용합니다."""

    def __init__(self, agent_id: str, log: list[str]):
        self.id, self.log = agent_id, log

    async def run(self, messages, ctx, task=None):
        name = messages[-1]["content"]
        self.log.append(f"{name} start")
        yield AgentEvent.text(f"{name}-0 ")
        await asyncio.sleep(0.2 if name == "A" else 0.01)
        yield AgentEvent.citation(f"doc-{name}")
        yield AgentEvent.text(f"{name}-1")
        self.log.append(f"{name} end")


def gateway_app(log, lanes=None):
    settings = Settings(
        backend_api_key=API_KEY, owui_jwt_secret=JWT_SECRET, permissions_file=str(PERMISSIONS_FILE),
        app_database_url="unused", keycloak_url="unused", keycloak_realm="capstone",
        keycloak_client_id="gateway", keycloak_client_secret="unused",
    )
    audit = MemoryAuditLog()
    agents = {a: TimedAgent(a, log) for a in ("super-agent", "advisory-agent", "news-agent", "meeting-agent")}
    return create_app(settings, directory=FakeDirectory(), audit=audit, agents=agents, lanes=lanes), audit


def chat_body(text, stream):
    return {"model": "news-agent", "messages": [{"role": "user", "content": text}], "stream": stream}


def chat_headers(chat_id):
    return {"Authorization": f"Bearer {API_KEY}", "X-OpenWebUI-User-Jwt": user_jwt("ceo@example.com"),
            "X-OpenWebUI-Chat-Id": chat_id, "Content-Type": "application/json"}


async def asgi_call(app, body: dict, headers: dict, leave_after: bytes | None = None) -> list[dict]:
    """uvicorn처럼 ASGI 앱을 부릅니다 (spec 2.3: 연결 끊김은 receive로 알림). leave_after가 오면 그 뒤 연결을 끊습니다."""
    left = asyncio.Event()
    sent: list[dict] = []
    first = True

    async def receive():
        nonlocal first
        if first:
            first = False
            return {"type": "http.request", "body": json.dumps(body).encode(), "more_body": False}
        await left.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)
        if leave_after and message["type"] == "http.response.body" and leave_after in message.get("body", b""):
            left.set()

    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1", "method": "POST",
        "scheme": "http", "path": "/v1/chat/completions", "raw_path": b"/v1/chat/completions", "query_string": b"",
        "root_path": "", "client": ("127.0.0.1", 50000), "server": ("gateway", 8000),
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
    }
    await app(scope, receive, send)
    return sent


def test_gateway_stream_left_mid_answer_keeps_its_chat_lane_and_records_its_documents():
    # Open WebUI가 쓰는 길(stream): A를 받다가 첫 글자 뒤에 멈춤 → 같은 대화의 B는 A의 실행이 끝난 뒤에 시작
    async def scenario():
        log: list[str] = []
        app, audit = gateway_app(log)
        sent = await asgi_call(app, chat_body("A", True), chat_headers("chat-1"), leave_after=b"A-0")
        assert not any(b"A-1" in m.get("body", b"") for m in sent)  # 떠난 뒤의 답변은 보내지 않음
        assert log == ["A start"]  # A는 아직 실행 중
        await asgi_call(app, chat_body("B", True), chat_headers("chat-1"))
        assert log == ["A start", "A end", "B start", "B end"]
        assert audit.entries[0].doc_ids == ["doc-A"]  # 떠난 뒤에 인용한 문서도 감사 로그에

    asyncio.run(scenario())


def test_gateway_stream_shows_the_wait_and_a_timed_out_request_gets_a_message():
    async def scenario():
        log: list[str] = []
        app, _ = gateway_app(log, lanes=Lanes(max_runs=4, wait_seconds=0.05))
        first = asyncio.create_task(asgi_call(app, chat_body("A", True), chat_headers("chat-1")))
        await settle()
        sent = await asgi_call(app, chat_body("B", True), chat_headers("chat-1"))
        body = b"".join(m.get("body", b"") for m in sent).decode()
        assert WAIT_SAME_CHAT in body and WAIT_TIMEOUT in body and "[DONE]" in body
        await first
        assert log == ["A start", "A end"]  # B는 실행되지 않음

    asyncio.run(scenario())


def test_gateway_runs_one_chat_in_order_and_chats_side_by_side():
    async def scenario():
        log: list[str] = []
        app, _ = gateway_app(log)

        async def ask(client, text, chat_id):
            r = await client.post("/v1/chat/completions", json=chat_body(text, False), headers=chat_headers(chat_id))
            assert r.status_code == 200, r.text
            return r.json()["choices"][0]["message"]["content"]

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as client:
            assert await asyncio.gather(ask(client, "A", "chat-1"), ask(client, "B", "chat-1")) == ["A-0 A-1", "B-0 B-1"]
            assert log == ["A start", "A end", "B start", "B end"]
            log.clear()
            await asyncio.gather(ask(client, "A", "chat-2"), ask(client, "B", "chat-3"))
            assert log[:2] == ["A start", "B start"]

    asyncio.run(scenario())


# --- 회의 관제의 회의록 요청 ---------------------------------------------------------------------------------


class SlowMeetingAgent:
    def __init__(self, log):
        self.log = log

    async def run(self, messages, ctx, task=None):
        name = task.split("녹음 파일: ")[1].split(" ·")[0]
        self.log.append(f"{name} start")
        yield AgentEvent.status("회의지원 Agent: 회의록 작성 중")
        await asyncio.sleep(0.1)
        yield AgentEvent.text("회의록 초안 저장")
        self.log.append(f"{name} end")


def minutes(client, filename):
    return client.post("/meetings/api/recording/minutes", headers={"Authorization": "Bearer t-secretary"},
                       json={"meeting_id": "MTG-2026-11-03-02", "filename": filename, "text": "[00:00] 김민수 (CEO): 시작"})


def test_minutes_for_one_meeting_run_one_after_another():
    async def scenario():
        log: list[str] = []
        app = app_with(Speech(), SlowMeetingAgent(log), MemoryAuditLog())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as client:
            first, second = await asyncio.gather(minutes(client, "a.wav"), minutes(client, "b.wav"))
        assert log == ["a.wav start", "a.wav end", "b.wav start", "b.wav end"]
        lines = [json.loads(line) for line in second.text.splitlines() if line.strip()]
        assert lines[0] == {"type": "status", "text": WAIT_SAME_MEETING} and lines[-1] == {"type": "done"}

    asyncio.run(scenario())


def test_minutes_that_cannot_get_a_lane_end_with_an_error_line():
    async def scenario():
        log: list[str] = []
        app = app_with(Speech(), SlowMeetingAgent(log), MemoryAuditLog(), lanes=Lanes(max_runs=4, wait_seconds=0.02))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as client:
            first, second = await asyncio.gather(minutes(client, "a.wav"), minutes(client, "b.wav"))
        assert log == ["a.wav start", "a.wav end"]  # b는 실행되지 않음
        lines = [json.loads(line) for line in second.text.splitlines() if line.strip()]
        assert lines == [{"type": "status", "text": WAIT_SAME_MEETING}, {"type": "error", "text": LANE_TIMEOUT_ERROR}, {"type": "done"}]

    asyncio.run(scenario())


def test_keepalive_fills_long_silences():
    async def scenario():
        async def slow():
            await asyncio.sleep(0.12)
            yield AgentEvent.text("끝")

        got = await collect(with_keepalive(slow(), 0.05))
        assert got[-1] == AgentEvent.text("끝") and got.count(None) >= 1

    asyncio.run(scenario())


# --- 설정 ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("raw", ["0", "4.5", "-1", "abc", "nan", "inf"])
def test_max_runs_must_be_a_whole_number_of_at_least_one(monkeypatch, raw):
    from gateway.settings import _number

    monkeypatch.setenv("GATEWAY_MAX_RUNS", raw)
    with pytest.raises(RuntimeError, match="GATEWAY_MAX_RUNS"):
        _number("GATEWAY_MAX_RUNS", 4, 1, integer=True)


@pytest.mark.parametrize("raw", ["0.5", "-3", "abc", "nan", "inf"])
def test_lane_wait_must_be_a_finite_number_of_at_least_a_second(monkeypatch, raw):
    from gateway.settings import _number

    monkeypatch.setenv("GATEWAY_LANE_WAIT_SECONDS", raw)
    with pytest.raises(RuntimeError, match="GATEWAY_LANE_WAIT_SECONDS"):
        _number("GATEWAY_LANE_WAIT_SECONDS", 600.0, 1)


def test_lane_settings_defaults_and_values(monkeypatch):
    from gateway.settings import _number

    monkeypatch.delenv("GATEWAY_MAX_RUNS", raising=False)
    assert _number("GATEWAY_MAX_RUNS", 4, 1, integer=True) == 4
    monkeypatch.setenv("GATEWAY_MAX_RUNS", " 6 ")
    assert _number("GATEWAY_MAX_RUNS", 4, 1, integer=True) == 6
    monkeypatch.setenv("GATEWAY_LANE_WAIT_SECONDS", "90.5")
    assert _number("GATEWAY_LANE_WAIT_SECONDS", 600.0, 1) == 90.5
