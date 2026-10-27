"""실제 Agent: Agent backend(agent-backend/, Group Agent System)를 호출합니다.

backend는 요청 하나를 받아 실행 lifecycle 이벤트를 NDJSON으로 스트리밍합니다
(POST /api/agents/{id}/run, 이벤트 형식은 agent-backend/backend/app/runtime/events.py).
여기서는 그 이벤트를 AgentEvent로 바꿉니다:

    호출한 Agent 자신의 agent_token        → text      (답변이 글자 단위로 스트리밍)
    위임 · A2A · Workflow Tool 진행 상황   → status    ("생각" 블록)
    Workflow 결과의 회의 · 기사 id         → citation  (감사 로그)
    error                                  → text      (어느 Agent가 실패했는지 안내)

Super Agent는 backend 안에서 전문 Agent에게 위임하므로, 위임 대상이 사용자가 직접 쓸 수
없는 Agent이면 그 시점에 실행을 끊습니다 (Super Agent가 권한표를 우회하는 통로가 되지 않도록).

요청에는 사용자(principal: email · 이름 · 그룹 · clearance)를 함께 보냅니다. backend의 Workflow Tool은
이 값으로 자료 접근을 거릅니다 (회의 기록의 등급 필터, 작성자 기록). backend는 내부망에서만 접근됩니다.
"""

import json
import re
from collections.abc import AsyncIterator

import httpx

from agents.base import AgentEvent, last_user_text, require_access
from shared.user_context import PermissionDenied, UserContext

# Gateway Agent id → (backend Agent id, 실행 경로)
BACKEND_AGENTS = {
    "super-agent": ("group_super", "/api/agents/group-super/run"),
    "advisory-agent": ("advisory", "/api/agents/advisory/run"),
    "news-agent": ("news", "/api/agents/news/run"),
    "meeting-agent": ("meeting", "/api/agents/meeting/run"),
}

# backend 전문 Agent id → permissions.yaml의 Agent id. Group과 K전자 모두 같은 id를 씁니다.
SPECIALIST_PERMISSIONS = {"meeting": "meeting-agent", "news": "news-agent", "advisory": "advisory-agent"}

AGENT_NAMES = {
    "group_super": "그룹 슈퍼에이전트",
    "k_super": "K전자 슈퍼에이전트",
    "meeting": "미팅 에이전트",
    "news": "뉴스 에이전트",
    "advisory": "경영자문 에이전트",
}
SYSTEM_NAMES = {"group": "그룹", "k_electronics": "K전자"}

# 위임 · A2A 결과를 "생각" 블록에 보여 줄 때의 최대 길이 (전체 답변은 Super Agent가 종합)
MAX_STATUS_CHARS = 600
# backend는 요청 문자열 하나만 받으므로, 이전 대화는 최근 몇 개만 요청 앞에 붙입니다.
MAX_HISTORY_MESSAGES = 6
MAX_HISTORY_CHARS = 1500

# 위임 · A2A 한 번이 수 분 걸릴 수 있지만, 그동안에도 이벤트가 계속 흘러옵니다.
BACKEND_TIMEOUT = httpx.Timeout(connect=5.0, read=600.0, write=10.0, pool=5.0)

_DETAILS = re.compile(r"<details\b.*?</details>", re.DOTALL)


def _clip(text: str, limit: int) -> str:
    text = str(text).strip()
    return text if len(text) <= limit else text[:limit].rstrip() + " …"


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # 멀티모달 메시지
        return " ".join(p.get("text", "") for p in content if p.get("type") == "text")
    return ""


def build_request(messages: list[dict]) -> str:
    """Open WebUI의 대화 기록 → backend 요청 문자열 (마지막 사용자 메시지 + 최근 대화 맥락)."""
    current = last_user_text(messages)
    turns = [m for m in messages if m.get("role") in ("user", "assistant")]
    if turns and turns[-1].get("role") == "user":
        turns = turns[:-1]
    history = []
    for m in turns[-MAX_HISTORY_MESSAGES:]:
        # Open WebUI가 답변에 붙여 둔 "생각" 블록은 맥락에서 뺍니다.
        text = _DETAILS.sub("", _text(m.get("content"))).strip()
        if text:
            speaker = "사용자" if m["role"] == "user" else "AI"
            history.append(f"{speaker}: {_clip(text, MAX_HISTORY_CHARS)}")
    if not history:
        return current
    return "[이전 대화]\n" + "\n".join(history) + "\n\n[현재 요청]\n" + current


def principal(ctx: UserContext) -> dict:
    """backend에 보내는 사용자 정보. Agent(LLM)가 아니라 backend의 Tool이 읽습니다."""
    return {"email": ctx.email, "name": ctx.name, "groups": sorted(ctx.groups), "clearance": ctx.clearance}


def agent_label(agent: str | None, system: str | None) -> str:
    name = AGENT_NAMES.get(agent or "", agent or "Agent")
    if agent in SPECIALIST_PERMISSIONS and system in SYSTEM_NAMES:
        return f"{SYSTEM_NAMES[system]} {name}"
    return name


def cited_documents(event: dict) -> list[str]:
    """Workflow Tool 결과에 들어 있는 회의 · 기사 id (system별로 구분)."""
    result = event.get("result")
    if not isinstance(result, dict):
        return []
    ids = [m.get("id") for m in result.get("meetings") or [] if isinstance(m, dict)]
    ids += [(r.get("source") or {}).get("id") for r in result.get("risks") or [] if isinstance(r, dict)]
    system = event.get("system", "")
    return [f"{system}/{i}" for i in ids if i]


class RemoteAgent:
    def __init__(self, agent_id: str, label: str, base_url: str, transport: httpx.AsyncBaseTransport | None = None):
        self.id = agent_id
        self.label = label
        self.backend_agent, self.path = BACKEND_AGENTS[agent_id]
        self.base_url = base_url.rstrip("/")
        self.transport = transport  # 테스트에서 가짜 backend로 교체

    async def run(
        self,
        messages: list[dict],
        ctx: UserContext,
        task: str | None = None,
    ) -> AsyncIterator[AgentEvent]:
        require_access(ctx, self.id)
        request = task or build_request(messages)
        try:
            async with httpx.AsyncClient(
                base_url=self.base_url, timeout=BACKEND_TIMEOUT, transport=self.transport
            ) as client:
                async with client.stream("POST", self.path, json={"request": request, "principal": principal(ctx)}) as resp:
                    if resp.status_code != 200:
                        await resp.aread()
                        yield AgentEvent.text(f"Agent backend가 요청을 거부했습니다 (HTTP {resp.status_code}).")
                        return
                    async for event in self._translate(resp.aiter_lines(), ctx):
                        yield event
        except httpx.HTTPError as exc:
            yield AgentEvent.text(f"\n\nAgent backend에 연결할 수 없습니다: {type(exc).__name__}")

    async def _translate(self, lines: AsyncIterator[str], ctx: UserContext) -> AsyncIterator[AgentEvent]:
        root = self.backend_agent
        answered = False  # 마지막 진행 상황 이후 이 Agent의 답변 텍스트가 나왔는가
        async for line in lines:
            if not line.strip():
                continue
            event = json.loads(line)
            kind = event.get("type")
            system = event.get("system")
            # 상대 system(K전자)에서 relay된 이벤트도 같은 이름을 쓰므로, 이 Agent 자신의 것인지 구분합니다.
            own = not event.get("relayed") and event.get("agent") == root

            if kind == "agent_token":
                if own:
                    yield AgentEvent.text(event.get("text", ""))
                    answered = True
                continue
            if kind == "agent_end":
                if own and not answered:  # 모델이 토큰을 스트리밍하지 않은 경우
                    yield AgentEvent.text(event.get("response", ""))
                continue
            if kind == "done":
                return
            if kind == "error":
                yield AgentEvent.text(
                    f"\n\n처리 중 오류가 발생했습니다 — {agent_label(event.get('agent'), system)}: {event.get('message', '')}"
                )
                return

            status = None
            if kind == "delegation_start":
                target = event.get("to")
                permission = SPECIALIST_PERMISSIONS.get(target)
                if permission and not ctx.can_use(permission):
                    yield AgentEvent.status(f"{agent_label(target, system)}: 사용 권한 없음 → 중단")
                    raise PermissionDenied(permission)
                status = f"{agent_label(event.get('from'), system)} → {agent_label(target, system)} 위임: {event.get('task', '')}"
            elif kind == "delegation_end":
                status = f"{agent_label(event.get('to'), system)} 보고: {_clip(event.get('response', ''), MAX_STATUS_CHARS)}"
            elif kind == "a2a_start":
                status = f"{agent_label(event.get('from'), system)} → {agent_label(event.get('to'), None)} A2A 요청: {event.get('request', '')}"
            elif kind == "a2a_end":
                status = f"{agent_label(event.get('to'), None)} A2A 응답: {_clip(event.get('response', ''), MAX_STATUS_CHARS)}"
            elif kind == "tool_start":
                args = json.dumps(event.get("args", {}), ensure_ascii=False)
                status = f"{agent_label(event.get('agent'), system)}: {event.get('tool')} 실행 {_clip(args, 300)}"
            elif kind == "tool_end":
                for doc_id in cited_documents(event):
                    yield AgentEvent.citation(doc_id)
                status = f"{agent_label(event.get('agent'), system)}: {event.get('tool')} 완료"
            if status:
                if answered:
                    # Tool · 위임 앞에 쓴 문장과 그 뒤의 답변이 붙지 않게 합니다.
                    yield AgentEvent.text("\n\n")
                    answered = False
                yield AgentEvent.status(status)
        yield AgentEvent.text("\n\nAgent backend의 응답이 완료 신호 없이 끊겼습니다.")
