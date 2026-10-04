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
                raise ValueError(f"group {name}: clearance must be 1..4, got {clearance}")
            unknown = set(spec["agents"]) - agents.keys()
            if unknown:
                raise ValueError(f"group {name}: unknown agents {sorted(unknown)}")
            groups[name] = GroupPolicy(name, spec.get("description", ""), clearance, frozenset(spec["agents"]))
        return cls(agents, groups)

    def resolve(self, user_groups: Iterable[str]) -> tuple[int, frozenset[str]]:
        """(clearance, allowed agent ids) for a user in these groups.
        Unknown groups grant nothing; multiple groups combine (max clearance, union of agents)."""
        policies = [self.groups[g] for g in user_groups if g in self.groups]
        clearance = max((p.clearance for p in policies), default=0)
        agents = frozenset().union(*(p.agents for p in policies))
        return clearance, agents
