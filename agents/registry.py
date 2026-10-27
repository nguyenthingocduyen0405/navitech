from agents.base import Agent
from agents.mock import MockAgent
from agents.remote import BACKEND_AGENTS, RemoteAgent
from agents.super_agent import SuperAgent


def build_registry(labels: dict[str, str], backend_url: str = "") -> dict[str, Agent]:
    """Agent id → Agent.

    backend_url(AGENT_BACKEND_URL)이 있으면 Agent backend의 실제 Agent를,
    없으면 backend 없이 흐름만 확인하는 mock Agent를 사용합니다 (테스트, 로컬 실행).
    """
    if backend_url:
        return {agent_id: RemoteAgent(agent_id, labels[agent_id], backend_url) for agent_id in BACKEND_AGENTS}
    sub_agents: dict[str, Agent] = {
        agent_id: MockAgent(agent_id, labels[agent_id])
        for agent_id in ("advisory-agent", "news-agent", "meeting-agent")
    }
    return {**sub_agents, "super-agent": SuperAgent(sub_agents, labels)}
