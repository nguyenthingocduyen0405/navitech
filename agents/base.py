from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, Protocol

from shared.user_context import PermissionDenied, UserContext

EventType = Literal["text", "status", "citation"]


@dataclass(frozen=True)
class AgentEvent:
    """Agent 출력의 한 조각.

    text     -> 사용자에게 보여 줄 답변
    status   -> 진행 상황 ("뉴스 Agent 호출 중..."), 접을 수 있는 "생각" 블록에 표시
    citation -> 답변에 사용한 문서 id (감사 로그에 기록)
    """

    type: EventType
    content: str = ""

    @classmethod
    def text(cls, content: str) -> "AgentEvent":
        return cls("text", content)

    @classmethod
    def status(cls, content: str) -> "AgentEvent":
        return cls("status", content)

    @classmethod
    def citation(cls, source_id: str) -> "AgentEvent":
        return cls("citation", source_id)


class Agent(Protocol):
    """직접 호출되든 Super Agent를 거치든 모든 Agent가 공유하는 인터페이스.

    messages: OpenAI 형식의 전체 대화 기록 (다른 Agent의 답변이 섞여 있을 수 있음)
    ctx:      요청자의 신원과 권한 — 모든 도구에 그대로 전달할 것
    task:     Super Agent가 호출할 때 넘기는 정리된 지시문; 직접 호출이면 None
    """

    id: str

    def run(
        self,
        messages: list[dict],
        ctx: UserContext,
        task: str | None = None,
    ) -> AsyncIterator[AgentEvent]: ...


def require_access(ctx: UserContext, agent_id: str) -> None:
    """모든 Agent가 가장 먼저 호출합니다. Gateway도 검사하지만 Super Agent는 하위 Agent를
    직접 호출하므로, 각 Agent가 스스로 권한을 확인해야 합니다."""
    if not ctx.can_use(agent_id):
        raise PermissionDenied(agent_id)


def last_user_text(messages: list[dict]) -> str:
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):  # 멀티모달 메시지
            return " ".join(p.get("text", "") for p in content if p.get("type") == "text")
    return ""
