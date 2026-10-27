from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class AgentSpec:
    id: str
    name: str
    description: str


@dataclass(frozen=True)
class GroupPolicy:
    name: str
    description: str
    clearance: int
    agents: frozenset[str]


@dataclass(frozen=True)
class Permissions:
    agents: dict[str, AgentSpec]
    groups: dict[str, GroupPolicy]

    @classmethod
    def load(cls, path: str | Path) -> "Permissions":
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        agents = {
            agent_id: AgentSpec(agent_id, spec["name"], spec.get("description", ""))
            for agent_id, spec in raw["agents"].items()
        }
        groups = {}
        for name, spec in raw["groups"].items():
            clearance = int(spec["clearance"])
            if not 1 <= clearance <= 4:
                raise ValueError(f"그룹 {name}: clearance는 1~4여야 합니다 (현재 {clearance})")
            unknown = set(spec["agents"]) - agents.keys()
            if unknown:
                raise ValueError(f"그룹 {name}: 정의되지 않은 Agent {sorted(unknown)}")
            groups[name] = GroupPolicy(name, spec.get("description", ""), clearance, frozenset(spec["agents"]))
        return cls(agents, groups)

    def resolve(self, user_groups: Iterable[str]) -> tuple[int, frozenset[str]]:
        """이 그룹들에 속한 사용자의 (열람 등급, 사용 가능한 Agent id).
        알 수 없는 그룹은 아무 권한도 주지 않으며, 여러 그룹은 합쳐집니다 (최고 등급, Agent 합집합)."""
        policies = [self.groups[g] for g in user_groups if g in self.groups]
        clearance = max((p.clearance for p in policies), default=0)
        agents = frozenset().union(*(p.agents for p in policies))
        return clearance, agents
