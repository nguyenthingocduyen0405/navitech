"""Lane: Agent 실행의 순서와 동시 실행 수를 정합니다.

- 대화마다 lane 하나: 같은 대화(Open WebUI chat id)의 요청은 겹쳐 실행되지 않습니다. 앞 답변이 아직
  만들어지는 중에 보낸 메시지는 앞 실행이 끝날 때까지 기다리고, "생각" 블록에 기다린다고 알립니다.
- 전체 동시 실행 수 제한(GATEWAY_MAX_RUNS): 넘는 요청은 도착한 순서대로 기다립니다. 같은 대화의 앞 실행을
  기다리는 요청은 자리를 차지하지 않습니다 (대화 lane을 먼저 얻고 나서 자리를 기다림).
- 실행은 Agent backend가 끝낼 때까지 lane을 쥡니다. 사용자가 멈춤을 눌러 스트림이 끊겨도 backend는
  시작한 실행을 끝까지 하므로, 그 사이 다음 메시지를 시작하면 한 대화의 두 실행이 겹치기 때문입니다.
  (agents/remote.py도 권한 중단 뒤 backend 실행이 끝날 때까지 읽습니다. 단 backend가 BACKEND_TIMEOUT 동안
  아무것도 보내지 않으면 연결이 끊기고 lane도 풀립니다.)
- 기다림에는 한도(GATEWAY_LANE_WAIT_SECONDS)가 있습니다. 넘으면 실행하지 않고 LaneTimeout을 냅니다
  (채팅은 안내 문장, 회의 관제는 오류 줄로 답함).

lane은 gateway 프로세스 메모리에 있습니다 (gateway는 프로세스 하나). Group → K전자 A2A 요청은 backend끼리
오가므로 lane을 거치지 않고, 그래서 Group 실행이 자기 lane을 기다리며 멈추는 일도 없습니다.
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable

from agents.base import AgentEvent

log = logging.getLogger("gateway.lanes")

WAIT_SAME_CHAT = "같은 대화의 앞 요청을 처리하는 중입니다. 끝나면 이어서 처리합니다."
WAIT_FULL = "지금 처리 중인 요청이 많아 순서를 기다리고 있습니다."
WAIT_TIMEOUT = "앞 요청이 아직 끝나지 않아 이번 요청을 처리하지 못했습니다. 잠시 후 다시 보내 주세요."

_END = object()


class LaneTimeout(Exception):
    """lane을 기다리는 시간이 한도를 넘었습니다."""


def lane_key(email: str, chat_id: str | None) -> str:
    """대화의 lane 이름. 사용자 이메일을 함께 넣어 다른 사용자의 같은 chat id(예: 임시 대화)가 한 줄에 서지 않게 합니다."""
    return f"{email}\n{chat_id or ''}"


def _label(key: str) -> str:
    """로그용 lane 이름 (사용자 이메일은 빼고 대화 · 회의 id만)."""
    return key.rsplit("\n", 1)[-1] or "(chat id 없음)"


class Lanes:
    def __init__(self, max_runs: int, wait_seconds: float):
        if max_runs < 1:
            raise ValueError("max_runs는 1 이상이어야 합니다")
        self.max_runs = max_runs
        self.wait_seconds = wait_seconds
        self._runs = asyncio.Semaphore(max_runs)
        self._chats: dict[str, asyncio.Lock] = {}
        self._users: dict[str, int] = {}  # lane마다 쥐고 있거나 기다리는 요청 수 (0이 되면 lane을 지움)
        self._tasks: set[asyncio.Task] = set()

    def _leave(self, key: str) -> None:
        self._users[key] -= 1
        if self._users[key] == 0:
            del self._users[key]
            del self._chats[key]

    async def stream(
        self,
        key: str,
        events: AsyncIterator[AgentEvent],
        *,
        on_done: Callable[[], Awaitable[None]] | None = None,
        abandoned: Callable[[], Awaitable[bool]] | None = None,
        same_lane_wait: str = WAIT_SAME_CHAT,
    ) -> AsyncIterator[AgentEvent]:
        """events(Agent 실행)를 key의 lane에서 돌리며 그 이벤트를 내보냅니다.

        기다려야 하면 그때마다 status 이벤트로 알립니다 (같은 lane의 앞 실행 → same_lane_wait, 빈자리 → WAIT_FULL).
        한도 안에 들어가지 못하면 실행하지 않고 LaneTimeout을 냅니다.
        abandoned: 자리를 얻은 직후 부릅니다. True면(요청한 쪽이 이미 떠남) 실행하지 않고 끝냅니다.
        실행은 별도 task가 끝까지 읽으므로, 받는 쪽이 중간에 그만둬도(스트림 끊김) lane은 실행이 끝난 뒤에 풀립니다.
        on_done은 실행이 끝난 뒤(lane을 푼 뒤) 한 번 부릅니다 (예: 감사 로그에 인용 문서 기록)."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.wait_seconds
        chat = self._chats.setdefault(key, asyncio.Lock())
        self._users[key] = self._users.get(key, 0) + 1
        got_chat = got_run = False
        try:
            try:
                if chat.locked():
                    yield AgentEvent.status(same_lane_wait)
                async with asyncio.timeout_at(deadline):
                    await chat.acquire()
                got_chat = True
                if self._runs.locked():
                    yield AgentEvent.status(WAIT_FULL)
                async with asyncio.timeout_at(deadline):
                    await self._runs.acquire()
                got_run = True
            except TimeoutError as e:
                log.warning("lane 대기 한도 초과 (%.0f초): %s", self.wait_seconds, _label(key))
                raise LaneTimeout(key) from e
        finally:
            if not got_run:  # 기다리다 끝남 (한도 초과 · 취소 · 스트림 닫힘): 아무것도 쥐지 않은 채로
                if got_chat:
                    chat.release()
                self._leave(key)

        released = False

        def release() -> None:
            nonlocal released
            if not released:
                released = True
                self._runs.release()
                chat.release()
                self._leave(key)

        try:
            if abandoned is not None and await abandoned():
                log.info("기다리는 동안 요청한 쪽이 떠나 실행하지 않음: %s", _label(key))
                release()
                return
        except BaseException:
            release()
            raise

        queue: asyncio.Queue = asyncio.Queue()
        listening = True

        async def pump() -> None:
            failure: Exception | None = None
            try:
                async for event in events:
                    queue.put_nowait(event)
            except Exception as e:  # 받는 쪽에 그대로 넘깁니다 (받는 쪽이 이미 떠났으면 아래에서 기록)
                failure = e
            finally:
                release()
                try:
                    if on_done is not None:
                        await on_done()
                except Exception:
                    log.exception("lane 실행 뒤 처리 실패")
                finally:
                    queue.put_nowait(failure or _END)  # on_done이 취소돼도 받는 쪽이 멈춰 있지 않게
            if failure is not None and not listening:
                log.error("스트림이 끊긴 뒤 Agent 실행 실패", exc_info=failure)

        task = asyncio.create_task(pump())  # 자리를 얻은 뒤 await 없이 바로 시작 (취소가 끼어들 틈 없음)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        try:
            while (item := await queue.get()) is not _END:
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            listening = False
