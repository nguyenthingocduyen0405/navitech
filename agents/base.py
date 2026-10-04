from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, Protocol

from shared.user_context import PermissionDenied, UserContext

EventType = Literal["text", "status", "citation"]


@dataclass(frozen=True)
class AgentEvent:
    """One piece of agent output.

    text     -> shown to the user as the answer
    status   -> progress ("뉴스 Agent 호출 중..."), shown in the collapsible thinking block
    citation -> id of a document the answer used (recorded in the audit log)
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
    """Interface shared by all agents, whether called directly or by the Super Agent.

    messages: full OpenAI-style chat history (may include other agents' replies)
    ctx:      the caller's identity and permissions — pass it to every tool
    task:     refined instruction when called by the Super Agent; None when called directly
    """

    id: str

    def run(
        self,
        messages: list[dict],
        ctx: UserContext,
        task: str | None = None,
    ) -> AsyncIterator[AgentEvent]: ...


def require_access(ctx: UserContext, agent_id: str) -> None:
    """Every agent calls this first. The gateway checks too, but the Super Agent
    calls sub-agents directly, so each agent must defend itself."""
    if not ctx.can_use(agent_id):
        raise PermissionDenied(agent_id)


def last_user_text(messages: list[dict]) -> str:
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):  # multimodal parts
            return " ".join(p.get("text", "") for p in content if p.get("type") == "text")
    return ""
