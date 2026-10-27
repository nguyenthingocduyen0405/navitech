from collections.abc import AsyncIterator

from agents.base import Agent, AgentEvent, last_user_text, require_access
from shared.user_context import UserContext

# 임시 라우터: 키워드 매칭. 실제로는 LLM 라우터(작고 빠른 모델 + 구조화 출력)로 교체하세요.
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
        # 사용자가 직접 쓸 수 있는 Agent에게만 위임합니다.
        # 그렇지 않으면 Super Agent가 권한표를 우회하는 통로가 됩니다.
        allowed = [a for a in wanted if ctx.can_use(a)]
        yield AgentEvent.status("라우팅: " + ", ".join(self.labels[a] for a in wanted))
        for agent_id in wanted:
            if agent_id not in allowed:
                yield AgentEvent.status(f"{self.labels[agent_id]}: 사용 권한 없음 → 건너뜀")

        if not allowed:
            yield AgentEvent.text("요청을 처리할 수 있는 Agent에 대한 사용 권한이 없습니다.")
            return

        if len(allowed) == 1:
            # Agent가 하나면 LLM 호출을 추가로 하지 않고 답변을 그대로 스트리밍합니다.
            async for event in self.sub_agents[allowed[0]].run(messages, ctx, task=question):
                yield event
            return

        # Agent가 여럿이면 결과를 모은 뒤 종합합니다 (mock: 섹션을 이어 붙임).
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
