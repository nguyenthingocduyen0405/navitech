"""Lane: 같은 대화의 요청은 차례로, 전체 동시 실행 수는 한도까지 (gateway/lanes.py)."""

import asyncio

import httpx
import pytest

from agents.base import AgentEvent
from gateway.audit import MemoryAuditLog
from gateway.lanes import WAIT_FULL, WAIT_SAME_CHAT, WAIT_TIMEOUT, Lanes, lane_key
from gateway.main import create_app
from gateway.settings import Settings
from test_gateway import API_KEY, JWT_SECRET, PERMISSIONS_FILE, FakeDirectory, user_jwt


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


async def collect(stream, into: list[AgentEvent]):
    async for event in stream:
        into.append(event)


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


def test_same_chat_waits_for_the_previous_run():
    async def scenario():
        lanes, log = Lanes(max_runs=4, wait_seconds=5), []
        a, b = Run("a", log), Run("b", log)
        got_a, got_b = [], []
        ta = asyncio.create_task(collect(lanes.stream("chat-1", a.events()), got_a))
        await settle()
        tb = asyncio.create_task(collect(lanes.stream("chat-1", b.events()), got_b))
        await settle()
        assert log == ["a start"]  # b는 아직 시작하지 않음
        assert got_b == [AgentEvent.status(WAIT_SAME_CHAT)]
        a.finish.set()
        await settle()
        assert log == ["a start", "a end", "b start"]
        b.finish.set()
        await asyncio.gather(ta, tb)
        assert [e.content for e in got_b[1:]] == ["b 답변 시작", "b 답변 끝"]
        assert lanes._chats == {} and lanes._users == {}  # 끝난 lane은 남지 않음

    asyncio.run(scenario())


def test_different_chats_run_at_the_same_time():
    async def scenario():
        lanes, log = Lanes(max_runs=4, wait_seconds=5), []
        a, b = Run("a", log), Run("b", log)
        tasks = [asyncio.create_task(collect(lanes.stream(k, r.events()), [])) for k, r in (("chat-1", a), ("chat-2", b))]
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
        tasks = [asyncio.create_task(collect(lanes.stream("chat-1", a.events()), []))]
        await settle()
        tasks.append(asyncio.create_task(collect(lanes.stream("chat-2", b.events()), got_b)))
        await settle()
        tasks.append(asyncio.create_task(collect(lanes.stream("chat-3", c.events()), [])))
        await settle()
        assert log == ["a start"] and got_b == [AgentEvent.status(WAIT_FULL)]
        a.finish.set()
        await settle()
        assert log == ["a start", "a end", "b start"]  # 먼저 온 b가 먼저
        b.finish.set(), c.finish.set()
        await asyncio.gather(*tasks)
        assert log == ["a start", "a end", "b start", "b end", "c start", "c end"]

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
        tb = asyncio.create_task(collect(lanes.stream("chat-1", b.events()), []))
        await settle()
        assert log == ["a start"] and done == []  # b는 a가 끝나기를 기다림
        a.finish.set()
        await settle()
        assert log == ["a start", "a end", "b start"] and done == ["a"]
        b.finish.set()
        await tb

    asyncio.run(scenario())


def test_wait_limit_answers_instead_of_running():
    async def scenario():
        lanes, log = Lanes(max_runs=4, wait_seconds=0.05), []
        a, b = Run("a", log), Run("b", log)
        ta = asyncio.create_task(collect(lanes.stream("chat-1", a.events()), []))
        await settle()
        got_b = []
        await collect(lanes.stream("chat-1", b.events()), got_b)
        assert got_b == [AgentEvent.status(WAIT_SAME_CHAT), AgentEvent.text(WAIT_TIMEOUT)]
        assert log == ["a start"]  # b는 실행되지 않음
        a.finish.set()
        await ta
        assert lanes._chats == {}

    asyncio.run(scenario())


def test_cancelled_wait_holds_nothing():
    async def scenario():
        lanes, log = Lanes(max_runs=1, wait_seconds=5), []
        a, b, c = Run("a", log), Run("b", log), Run("c", log)
        ta = asyncio.create_task(collect(lanes.stream("chat-1", a.events()), []))
        await settle()
        tb = asyncio.create_task(collect(lanes.stream("chat-1", b.events()), []))
        await settle()
        tb.cancel()  # 기다리던 사용자가 떠남
        with pytest.raises(asyncio.CancelledError):
            await tb
        a.finish.set()
        await ta
        c.finish.set()
        await collect(lanes.stream("chat-1", c.events()), [])
        assert log == ["a start", "a end", "c start", "c end"]
        assert lanes._chats == {} and lanes._users == {}

    asyncio.run(scenario())


def test_failed_run_reaches_the_reader_and_frees_the_lane():
    async def scenario():
        lanes, log = Lanes(max_runs=1, wait_seconds=5), []
        a = Run("a", log, fail=True)
        a.finish.set()
        with pytest.raises(RuntimeError, match="backend 끊김"):
            await collect(lanes.stream("chat-1", a.events()), [])
        b = Run("b", log)
        b.finish.set()
        await collect(lanes.stream("chat-1", b.events()), [])
        assert log == ["a start", "b start", "b end"]

    asyncio.run(scenario())


def test_lane_key_keeps_users_apart():
    assert lane_key("a@example.com", "local") != lane_key("b@example.com", "local")
    assert lane_key("a@example.com", None) == lane_key("a@example.com", "")


class SlowAgent:
    """gateway를 거친 요청: 같은 chat id면 겹치지 않아야 합니다."""

    def __init__(self, agent_id: str, log: list[str]):
        self.id, self.log = agent_id, log

    async def run(self, messages, ctx, task=None):
        name = messages[-1]["content"]
        self.log.append(f"{name} start")
        await asyncio.sleep(0.05)
        self.log.append(f"{name} end")
        yield AgentEvent.text(f"{name} 답변")


def test_gateway_runs_one_chat_in_order_and_chats_side_by_side():
    async def scenario():
        log: list[str] = []
        settings = Settings(
            backend_api_key=API_KEY, owui_jwt_secret=JWT_SECRET, permissions_file=str(PERMISSIONS_FILE),
            app_database_url="unused", keycloak_url="unused", keycloak_realm="capstone",
            keycloak_client_id="gateway", keycloak_client_secret="unused",
        )
        agents = {a: SlowAgent(a, log) for a in ("super-agent", "advisory-agent", "news-agent", "meeting-agent")}
        app = create_app(settings, directory=FakeDirectory(), audit=MemoryAuditLog(), agents=agents)
        transport = httpx.ASGITransport(app=app)

        async def ask(client, text, chat_id):
            headers = {"Authorization": f"Bearer {API_KEY}", "X-OpenWebUI-User-Jwt": user_jwt("ceo@example.com"),
                       "X-OpenWebUI-Chat-Id": chat_id}
            body = {"model": "news-agent", "messages": [{"role": "user", "content": text}], "stream": False}
            r = await client.post("/v1/chat/completions", json=body, headers=headers)
            assert r.status_code == 200, r.text
            return r.json()["choices"][0]["message"]["content"]

        async with httpx.AsyncClient(transport=transport, base_url="http://gateway") as client:
            answers = await asyncio.gather(ask(client, "q1", "chat-1"), ask(client, "q2", "chat-1"))
            assert answers == ["q1 답변", "q2 답변"]
            assert log == ["q1 start", "q1 end", "q2 start", "q2 end"]
            log.clear()
            await asyncio.gather(ask(client, "q3", "chat-2"), ask(client, "q4", "chat-3"))
            assert log[:2] == ["q3 start", "q4 start"]

    asyncio.run(scenario())
