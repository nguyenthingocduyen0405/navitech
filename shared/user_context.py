from dataclasses import dataclass


@dataclass(frozen=True)
class UserContext:
    """Who is asking and what they may touch.

    Built once per request by the gateway and passed unchanged to every agent,
    tool and retrieval call. Agents must never widen it.
    """

    email: str
    name: str
    groups: frozenset[str]
    clearance: int  # 0 = nothing, 1 = 공개, 2 = 사내, 3 = 대외비, 4 = 극비
    allowed_agents: frozenset[str]
    meeting_ids: frozenset[str] = frozenset()  # TODO: load from meeting membership once meeting tables exist
    chat_id: str | None = None

    def can_use(self, agent_id: str) -> bool:
        return agent_id in self.allowed_agents


class PermissionDenied(Exception):
    """Raised when a user tries to use an agent or data they are not allowed to."""
