from agents.base import Agent
from agents.mock import MockAgent
from agents.super_agent import SuperAgent


def build_registry(labels: dict[str, str]) -> dict[str, Agent]:
    """agent id -> agent. Swap MockAgent for the real agents here."""
    sub_agents: dict[str, Agent] = {
        agent_id: MockAgent(agent_id, labels[agent_id])
        for agent_id in ("advisory-agent", "news-agent", "meeting-agent")
    }
    return {**sub_agents, "super-agent": SuperAgent(sub_agents, labels)}
