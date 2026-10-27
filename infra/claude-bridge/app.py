"""OpenAI-compatible /v1/chat/completions on top of a Claude subscription.

The agent backend (LLM_PROVIDER=openai) talks to this service like any
OpenAI-compatible API. Each request runs one Claude Code turn through the
Claude Agent SDK, authenticated with CLAUDE_CODE_OAUTH_TOKEN (`claude
setup-token`), so no paid API key is used. For development/testing only.

    OpenAI tools      → in-process MCP tools; a PreToolUse hook defers every
                        call, so Claude's tool calls come back to the caller
                        (LangGraph runs them) instead of executing here
    message history   → system prompt + a rendered transcript (the SDK cannot
                        take prior assistant/tool messages directly)
    stream=true       → SSE chunks: text deltas, then tool_calls, then [DONE]
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    StreamEvent,
    ToolUseBlock,
    create_sdk_mcp_server,
    query,
    tool,
)
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

log = logging.getLogger("claude-bridge")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

MCP_SERVER = "lg"
MCP_PREFIX = f"mcp__{MCP_SERVER}__"
DEFAULT_MODEL = os.environ.get("CLAUDE_MODEL", "sonnet")
EFFORT = os.environ.get("CLAUDE_EFFORT", "").strip() or None  # low | medium | high | ...
API_KEY = os.environ.get("BRIDGE_API_KEY", "").strip()
# Every request is one Claude Code process (~200 MB); the VM has 4 GB.
SEMAPHORE = asyncio.Semaphore(int(os.environ.get("BRIDGE_MAX_CONCURRENCY", "2")))
TIMEOUT = float(os.environ.get("BRIDGE_TIMEOUT_SECONDS", "300"))
# Empty working directory: no CLAUDE.md or project settings get picked up.
WORKDIR = tempfile.mkdtemp(prefix="claude-bridge-")

BRIDGE_NOTE = (
    "You are running behind an API bridge: the transcript below is the conversation so far. "
    "Lines tagged <assistant_tool_call> are tool calls you already made and <tool_result> holds what they "
    "returned. To call a tool now, use the real tool-use mechanism (never write a tool call as text). "
    "Reply only with your next assistant turn."
)

app = FastAPI(title="claude-bridge")


class BridgeError(Exception):
    def __init__(self, status: int, message: str, kind: str = "api_error"):
        super().__init__(message)
        self.status, self.message, self.kind = status, message, kind


# ---------------------------------------------------------------------------
# OpenAI request → Claude Agent SDK
# ---------------------------------------------------------------------------


def _text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
        elif isinstance(part, dict) and part.get("type") == "text":
            parts.append(part.get("text", ""))
    return "\n".join(parts)


def build_prompt(messages: list[dict]) -> tuple[str, str]:
    """(system prompt, user prompt). A lone user message is sent as is."""
    system = "\n\n".join(_text(m.get("content")) for m in messages if m.get("role") in ("system", "developer"))
    rest = [m for m in messages if m.get("role") not in ("system", "developer")]
    if len(rest) == 1 and rest[0].get("role") == "user":
        return system, _text(rest[0].get("content"))

    lines = ["<conversation>"]
    for m in rest:
        role = m.get("role")
        if role == "user":
            lines.append(f"<user>\n{_text(m.get('content'))}\n</user>")
        elif role == "assistant":
            if text := _text(m.get("content")).strip():
                lines.append(f"<assistant>\n{text}\n</assistant>")
            for call in m.get("tool_calls") or []:
                fn = call.get("function", {})
                lines.append(
                    f'<assistant_tool_call id="{call.get("id")}" name="{fn.get("name")}">'
                    f"{fn.get('arguments', '{}')}</assistant_tool_call>"
                )
        elif role == "tool":
            lines.append(f'<tool_result id="{m.get("tool_call_id")}">\n{_text(m.get("content"))}\n</tool_result>')
    lines.append("</conversation>")
    system = f"{system}\n\n{BRIDGE_NOTE}" if system else BRIDGE_NOTE
    return system, "\n".join(lines)


def build_tools(openai_tools: list[dict] | None) -> list:
    out = []
    for t in openai_tools or []:
        fn = t.get("function", t)
        schema = dict(fn.get("parameters") or {})
        schema.setdefault("type", "object")
        schema.setdefault("properties", {})

        async def _never(_args: dict) -> dict:  # the PreToolUse hook defers every call first
            return {"content": [{"type": "text", "text": "deferred"}]}

        out.append(tool(fn["name"], fn.get("description", ""), schema)(_never))
    return out


async def _defer_tool(_input: dict, _tool_use_id: str | None, _ctx: Any) -> dict:
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "defer"}}


def resolve_model(requested: str | None) -> str:
    m = (requested or "").strip()
    if m.startswith("claude") or m in ("sonnet", "opus", "haiku", "fable"):
        return m
    return DEFAULT_MODEL


async def run_claude(body: dict) -> AsyncIterator[tuple[str, Any]]:
    """Yields ("text", str) deltas, then ("tool_calls", [...]) and ("done", finish_reason)."""
    messages = body.get("messages") or []
    system, prompt = build_prompt(messages)
    tool_choice = body.get("tool_choice")
    tools = [] if tool_choice == "none" else build_tools(body.get("tools"))
    if tool_choice == "required" and tools:
        system += "\n\nYou must call at least one tool in this turn."
    elif isinstance(tool_choice, dict) and tools:
        system += f"\n\nYou must call the tool `{tool_choice.get('function', {}).get('name')}` in this turn."

    options = ClaudeAgentOptions(
        model=resolve_model(body.get("model")),
        system_prompt=system or None,
        tools=[],  # no built-in Claude Code tools (Bash, Read, ...)
        mcp_servers={MCP_SERVER: create_sdk_mcp_server(MCP_SERVER, tools=tools)} if tools else {},
        allowed_tools=[f"{MCP_PREFIX}{t.name}" for t in tools],
        strict_mcp_config=True,
        setting_sources=[],
        hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[_defer_tool])]} if tools else None,
        include_partial_messages=True,
        max_turns=1,
        cwd=WORKDIR,
        effort=EFFORT,
        env={"ENABLE_TOOL_SEARCH": "false", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"},
        extra_args={"no-session-persistence": None},
    )

    calls: list[dict] = []
    seen: set[str] = set()
    async for msg in query(prompt=prompt, options=options):
        if isinstance(msg, StreamEvent):
            ev = msg.event
            if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta":
                yield "text", ev["delta"]["text"]
        elif isinstance(msg, AssistantMessage):
            if msg.error:
                raise BridgeError(*_error_status(msg.error))
            for block in msg.content:
                if isinstance(block, ToolUseBlock) and block.id not in seen:
                    seen.add(block.id)
                    calls.append({"id": block.id, "name": block.name.removeprefix(MCP_PREFIX), "input": block.input})
        elif isinstance(msg, ResultMessage):
            deferred = msg.deferred_tool_use
            if deferred and deferred.id not in seen:
                calls.append({"id": deferred.id, "name": deferred.name.removeprefix(MCP_PREFIX), "input": deferred.input})
            if msg.is_error and not calls and msg.subtype != "error_max_turns":
                raise BridgeError(502, f"Claude run failed: {msg.subtype} {msg.result or ''}".strip())
            log.info(
                "model=%s turns=%s duration_ms=%s tool_calls=%s usage=%s",
                options.model, msg.num_turns, msg.duration_ms, [c["name"] for c in calls], msg.usage,
            )
    if calls:
        yield "tool_calls", calls
    yield "done", "tool_calls" if calls else "stop"


def _error_status(error: str) -> tuple[int, str, str]:
    return {
        "rate_limit": (429, "Claude subscription rate limit reached", "rate_limit_error"),
        "authentication_failed": (401, "Claude authentication failed — check CLAUDE_CODE_OAUTH_TOKEN", "authentication_error"),
        "billing_error": (402, "Claude subscription billing error", "billing_error"),
    }.get(error, (502, f"Claude error: {error}", "api_error"))


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------


def _error(e: BridgeError) -> JSONResponse:
    return JSONResponse({"error": {"message": e.message, "type": e.kind}}, status_code=e.status)


def _check_auth(request: Request) -> None:
    if API_KEY and request.headers.get("authorization", "") != f"Bearer {API_KEY}":
        raise BridgeError(401, "invalid bridge API key", "authentication_error")


def _openai_tool_calls(calls: list[dict]) -> list[dict]:
    return [
        {"index": i, "id": c["id"], "type": "function",
         "function": {"name": c["name"], "arguments": json.dumps(c["input"], ensure_ascii=False)}}
        for i, c in enumerate(calls)
    ]


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "model": DEFAULT_MODEL, "token": bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))}


@app.get("/v1/models")
async def models() -> dict:
    names = [DEFAULT_MODEL, "sonnet", "opus", "haiku"]
    return {"object": "list", "data": [{"id": n, "object": "model", "owned_by": "anthropic"} for n in dict.fromkeys(names)]}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    try:
        _check_auth(request)
    except BridgeError as e:
        return _error(e)
    body = await request.json()
    cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    model = resolve_model(body.get("model"))

    # The run happens in a task feeding a queue; the response waits for its first item so
    # auth / rate-limit failures become real HTTP errors (and the openai client's retries apply).
    queue: asyncio.Queue = asyncio.Queue()

    async def producer() -> None:
        async with SEMAPHORE:
            try:
                async with asyncio.timeout(TIMEOUT):
                    async for item in run_claude(body):
                        await queue.put(item)
            except BridgeError as e:
                await queue.put(("error", e))
            except TimeoutError:
                await queue.put(("error", BridgeError(504, f"Claude did not answer within {TIMEOUT:.0f}s")))
            except Exception as e:  # noqa: BLE001 — surface anything to the client
                log.exception("claude run failed")
                await queue.put(("error", BridgeError(502, f"{type(e).__name__}: {e}")))
            finally:
                await queue.put(None)

    task = asyncio.create_task(producer())
    first = await queue.get()
    if first is not None and first[0] == "error":
        await task
        return _error(first[1])

    async def items() -> AsyncIterator[tuple[str, Any]]:
        item = first
        while item is not None:
            yield item
            item = await queue.get()

    if not body.get("stream"):
        text, calls, finish = [], [], "stop"
        async for kind, value in items():
            if kind == "error":
                return _error(value)
            if kind == "text":
                text.append(value)
            elif kind == "tool_calls":
                calls = value
            elif kind == "done":
                finish = value
        message: dict[str, Any] = {"role": "assistant", "content": "".join(text) or None}
        if calls:
            message["tool_calls"] = [{k: v for k, v in c.items() if k != "index"} for c in _openai_tool_calls(calls)]
        return {
            "id": cid, "object": "chat.completion", "created": created, "model": model,
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    def chunk(delta: dict, finish: str | None = None) -> str:
        data = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

    async def sse() -> AsyncIterator[str]:
        yield chunk({"role": "assistant", "content": ""})
        async for kind, value in items():
            if kind == "error":
                yield f"data: {json.dumps({'error': {'message': value.message, 'type': value.kind}})}\n\n"
                return
            if kind == "text":
                yield chunk({"content": value})
            elif kind == "tool_calls":
                yield chunk({"tool_calls": _openai_tool_calls(value)})
            elif kind == "done":
                yield chunk({}, value)
        yield "data: [DONE]\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream")
