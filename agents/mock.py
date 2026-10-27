"""전체 흐름을 처음부터 끝까지 돌려 보기 위한 임시(mock) Agent.

각 MockAgent를 실제 구현으로 교체하되 `run` 시그니처는 그대로 유지하세요.
"""

from collections.abc import AsyncIterator

from agents.base import AgentEvent, last_user_text, require_access
from shared.access import can_read
from shared.user_context import UserContext

# 자료 단위 권한 필터링을 보여 주기 위한 가짜 문서 모음. 실제 자료는 RAG 저장소에 있습니다.
MOCK_DOCUMENTS = [
    {"id": "dart-2026-q2-report", "classification": 1, "source": "DART"},
    {"id": "industry-hbm-trend", "classification": 2, "source": "증권사 리포트"},
    {"id": "board-meeting-2026-09", "classification": 3, "source": "이사회 회의록"},
    {"id": "ceo-strategy-memo", "classification": 4, "source": "CEO 미팅 자료"},
]


class MockAgent:
    def __init__(self, agent_id: str, label: str):
        self.id = agent_id
        self.label = label

    async def run(
        self,
        messages: list[dict],
        ctx: UserContext,
        task: str | None = None,
    ) -> AsyncIterator[AgentEvent]:
        require_access(ctx, self.id)
        question = task or last_user_text(messages)
        yield AgentEvent.status(f"{self.label}: 자료 검색 중 (clearance {ctx.clearance})")

        readable = [d for d in MOCK_DOCUMENTS if can_read(ctx, d)]
        for doc in readable:
            yield AgentEvent.citation(doc["id"])

        sources = "\n".join(f"- {d['source']} (`{d['id']}`)" for d in readable) or "- (열람 가능한 자료 없음)"
        yield AgentEvent.text(
            f"**[{self.label} · mock]**\n\n"
            f"질문: {question}\n\n"
            f"{ctx.name or ctx.email} 님이 열람 가능한 자료:\n{sources}\n"
        )
