from dataclasses import dataclass


@dataclass(frozen=True)
class UserContext:
    """누가 요청했고, 무엇에 접근할 수 있는지.

    Gateway가 요청마다 한 번 만들어 모든 Agent, 도구, 검색 호출에 그대로 전달합니다.
    Agent는 이 권한을 절대 넓히면 안 됩니다.
    """

    email: str
    name: str
    groups: frozenset[str]
    clearance: int  # 0 = 없음, 1 = 공개, 2 = 사내, 3 = 대외비, 4 = 극비
    allowed_agents: frozenset[str]
    meeting_ids: frozenset[str] = frozenset()  # TODO: 회의 테이블이 생기면 참석자 정보로 채우기
    chat_id: str | None = None

    def can_use(self, agent_id: str) -> bool:
        return agent_id in self.allowed_agents


class PermissionDenied(Exception):
    """사용자가 권한 없는 Agent나 자료를 사용하려 할 때 발생합니다."""
