from collections.abc import AsyncIterator

from agents.base import Agent, AgentEvent, last_user_text, require_access
from shared.user_context import UserContext

# Mock router: keyword matching. Replace with an LLM router (small, fast model + structured output).
ROUTES = {
    "news-agent": ("뉴스", "news", "동향", "tin tức"),
    "meeting-agent": ("회의", "meeting", "action item", "họp"),
    "advisory-agent": ("전략", "투자", "리스크", "strategy", "chiến lược"),
}
DEFAULT_ROUTE = ["advisory-agent"]


class SuperAgent:
    id = "super-agent"

    def __init__(self, sub_agents: dict[str, Agent], labels: dict[str, str]):
        self.sub_agents = sub_agents
        self.labels = labels

    def route(self, question: str) -> list[str]:
        q = question.lower()
        picked = [agent_id for agent_id, keywords in ROUTES.items() if any(k in q for k in keywords)]
        return picked or DEFAULT_ROUTE

    async def run(
        self,
        messages: list[dict],
        ctx: UserContext,
        task: str | None = None,
    ) -> AsyncIterator[AgentEvent]:
        require_access(ctx, self.id)
        question = task or last_user_text(messages)

        wanted = self.route(question)
        # Only delegate to agents the user may use directly — otherwise the
        # Super Agent becomes a way around the permission table.
        allowed = [a for a in wanted if ctx.can_use(a)]
        yield AgentEvent.status("라우팅: " + ", ".join(self.labels[a] for a in wanted))
        for agent_id in wanted:
            if agent_id not in allowed:
                yield AgentEvent.status(f"{self.labels[agent_id]}: 사용 권한 없음 → 건너뜀")

        if not allowed:
            yield AgentEvent.text("요청을 처리할 수 있는 Agent에 대한 사용 권한이 없습니다.")
            return

        if len(allowed) == 1:
            # Single agent: stream its answer straight through, no extra LLM pass.
            async for event in self.sub_agents[allowed[0]].run(messages, ctx, task=question):
                yield event
            return

        # Several agents: collect, then synthesize (mock: concatenate sections).
        sections = []
        for agent_id in allowed:
            yield AgentEvent.status(f"{self.labels[agent_id]} 호출 중...")
            parts = []
            async for event in self.sub_agents[agent_id].run(messages, ctx, task=question):
                if event.type == "text":
                    parts.append(event.content)
                else:
                    yield event
            sections.append("".join(parts))
        yield AgentEvent.text("\n\n---\n\n".join(sections))
