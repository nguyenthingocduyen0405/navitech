"""Lane: Agent 실행의 순서와 동시 실행 수를 정합니다.

- 대화마다 lane 하나: 같은 대화(Open WebUI chat id)의 요청은 겹쳐 실행되지 않습니다. 앞 답변이 아직
  만들어지는 중에 보낸 메시지는 앞 실행이 끝날 때까지 기다리고, "생각" 블록에 기다린다고 알립니다.
- 전체 동시 실행 수 제한(GATEWAY_MAX_RUNS): 넘는 요청은 도착한 순서대로 기다립니다.
- 실행은 Agent backend가 끝낼 때까지 lane을 쥡니다. 사용자가 멈춤을 눌러 스트림이 끊겨도 backend는
  시작한 실행을 끝까지 하므로, 그 사이 다음 메시지를 시작하면 한 대화의 두 실행이 겹치기 때문입니다.
- 기다림에는 한도(GATEWAY_LANE_WAIT_SECONDS)가 있습니다. 넘으면 실행하지 않고 안내 문장으로 답합니다.

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

    def waiting_reason(self, key: str) -> str | None:
        """지금 들어가면 기다려야 하는 이유 (없으면 None)."""
        chat = self._chats.get(key)
        if chat is not None and chat.locked():
            return WAIT_SAME_CHAT
        if self._runs.locked():
            return WAIT_FULL
        return None

    async def acquire(self, key: str) -> Callable[[], None]:
        """key의 lane과 전체 실행 자리 하나를 얻고, 둘을 돌려주는 함수를 반환합니다.
        한도 안에 얻지 못하면 LaneTimeout. 기다리다 취소되면 아무것도 쥐지 않은 채로 끝납니다."""
        chat = self._chats.setdefault(key, asyncio.Lock())
        self._users[key] = self._users.get(key, 0) + 1
        got_chat = got_run = False
        try:
            async with asyncio.timeout(self.wait_seconds):
                await chat.acquire()
                got_chat = True
                await self._runs.acquire()
                got_run = True
        except TimeoutError as e:
            raise LaneTimeout(key) from e
        finally:
            if not got_run:
                if got_chat:
                    chat.release()
                self._leave(key)

        released = False

        def release() -> None:
            nonlocal released
            if released:
                return
            released = True
            self._runs.release()
            chat.release()
            self._leave(key)

        return release

    def _leave(self, key: str) -> None:
        self._users[key] -= 1
        if self._users[key] == 0:
            del self._users[key]
            del self._chats[key]

    async def stream(
        self,
        key: str,
        events: AsyncIterator[AgentEvent],
        on_done: Callable[[], Awaitable[None]] | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """events(Agent 실행)를 key의 lane에서 돌리며 그 이벤트를 내보냅니다.

        기다려야 하면 먼저 status 이벤트로 알리고, 한도를 넘으면 실행 대신 안내 text 하나로 끝냅니다.
        실행은 별도 task가 끝까지 읽으므로, 받는 쪽이 중간에 그만둬도(스트림 끊김) lane은 실행이 끝난 뒤에 풀립니다.
        on_done은 실행이 끝난 뒤(lane을 푼 뒤) 한 번 부릅니다 (예: 감사 로그에 인용 문서 기록)."""
        reason = self.waiting_reason(key)
        if reason:
            yield AgentEvent.status(reason)
        try:
            release = await self.acquire(key)
        except LaneTimeout:
            log.warning("lane 대기 한도 초과 (%.0f초)", self.wait_seconds)
            yield AgentEvent.text(WAIT_TIMEOUT)
            return

        queue: asyncio.Queue = asyncio.Queue()
        listening = True

        async def pump() -> None:
            failure: Exception | None = None
            try:
                async for event in events:
                    queue.put_nowait(event)
            except Exception as e:  # 받는 쪽에 그대로 넘깁니다 (받는 쪽이 이미 떠났으면 여기서 기록)
                failure = e
            finally:
                release()
                try:
                    if on_done is not None:
                        await on_done()
                except Exception:
                    log.exception("lane 실행 뒤 처리 실패")
                queue.put_nowait(failure or _END)
            if failure is not None and not listening:
                log.error("스트림이 끊긴 뒤 Agent 실행 실패", exc_info=failure)

        task = asyncio.create_task(pump())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        try:
            while (item := await queue.get()) is not _END:
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            listening = False
