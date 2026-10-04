"""OpenAI-compatible gateway in front of all agents.

Open WebUI talks to this service as if it were the OpenAI API. Each agent is a
"model". Every chat request is authenticated, authorized against
config/permissions.yaml and written to the audit log before the agent runs.

Run: uvicorn gateway.main:create_app --factory
"""

import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from agents.base import Agent, AgentEvent, last_user_text
from agents.registry import build_registry
from gateway.audit import AuditEntry, AuditLog, PostgresAuditLog
from gateway.auth import AuthError, build_user_context, check_api_key, verify_openwebui_jwt
from gateway.directory import Directory, DirectoryUnavailable, KeycloakDirectory
from gateway.permissions import Permissions
from gateway.settings import Settings
from shared.user_context import PermissionDenied

log = logging.getLogger("gateway")


def _error(status_code: int, message: str) -> JSONResponse:
    # OpenAI error shape — Open WebUI shows `message` to the user.
    return JSONResponse(
        status_code=status_code,
        content={"error": {"message": message, "type": "gateway_error", "code": status_code}},
    )


class Completion:
    """Formats agent output as OpenAI chat.completion / chat.completion.chunk payloads."""

    def __init__(self, model: str):
        self.id = f"chatcmpl-{uuid.uuid4().hex}"
        self.model = model
        self.created = int(time.time())

    def chunk(self, delta: dict, finish_reason: str | None = None) -> str:
        payload = {
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    def full(self, text: str, reasoning: str) -> dict:
        message = {"role": "assistant", "content": text}
        if reasoning:
            message["reasoning_content"] = reasoning
        return {
            "id": self.id,
            "object": "chat.completion",
            "created": self.created,
            "model": self.model,
            "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }


async def _guarded(events: AsyncIterator[AgentEvent], cited: list[str]) -> AsyncIterator[AgentEvent]:
    """Collect citations for the audit log; turn agent failures into a message instead of a broken stream."""
    try:
        async for event in events:
            if event.type == "citation" and event.content not in cited:
                cited.append(event.content)
            yield event
    except PermissionDenied:
        yield AgentEvent.text("\n\n요청하신 작업에 대한 권한이 없습니다.")
    except Exception:
        log.exception("agent failed")
        yield AgentEvent.text("\n\n처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.")


def create_app(
    settings: Settings | None = None,
    *,
    permissions: Permissions | None = None,
    directory: Directory | None = None,
    audit: AuditLog | None = None,
    agents: dict[str, Agent] | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    permissions = permissions or Permissions.load(settings.permissions_file)
    agents = agents or build_registry({a.id: a.name for a in permissions.agents.values()})
    mismatch = set(permissions.agents) ^ set(agents)
    if mismatch:
        raise RuntimeError(f"permissions.yaml and the agent registry disagree on: {sorted(mismatch)}")
    directory = directory or KeycloakDirectory(
        settings.keycloak_url,
        settings.keycloak_realm,
        settings.keycloak_client_id,
        settings.keycloak_client_secret,
    )
    audit = audit or PostgresAuditLog(settings.app_database_url)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await audit.start()
        try:
            yield
        finally:
            await audit.close()
            await directory.close()

    app = FastAPI(title="Capstone Agent Gateway", lifespan=lifespan)

    @app.exception_handler(AuthError)
    async def on_auth_error(_request: Request, exc: AuthError):
        return _error(exc.status_code, exc.message)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/v1/models")
    async def list_models(request: Request):
        # Every agent is listed. Per-user visibility is handled by Open WebUI's model
        # access control (synced from the same permissions.yaml), and the real check
        # happens on each chat request. Open WebUI caches this list, so filtering it
        # per user here would be unreliable.
        check_api_key(request.headers.get("authorization"), settings.backend_api_key)
        return {
            "object": "list",
            "data": [
                {
                    "id": a.id,
                    "object": "model",
                    "created": 0,
                    "owned_by": "capstone",
                    "name": a.name,
                    "description": a.description,
                }
                for a in permissions.agents.values()
            ],
        }

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request):
        check_api_key(request.headers.get("authorization"), settings.backend_api_key)
        claims = verify_openwebui_jwt(request.headers.get(settings.user_jwt_header), settings.owui_jwt_secret)
        body = await request.json()
        model = body.get("model", "")
        messages = body.get("messages") or []

        try:
            ctx = await build_user_context(
                claims, directory, permissions, chat_id=request.headers.get(settings.chat_id_header)
            )
        except DirectoryUnavailable:
            log.exception("directory lookup failed")
            return _error(503, "사용자 권한을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.")

        agent = agents.get(model)
        if agent is None:
            return _error(404, f"unknown model {model!r}")

        entry = AuditEntry(
            email=ctx.email,
            agent=model,
            allowed=ctx.can_use(model),
            reason=None if ctx.can_use(model) else "agent not permitted",
            chat_id=ctx.chat_id,
            query=last_user_text(messages),
        )
        try:
            entry_id = await audit.record(entry)
        except Exception:
            log.exception("audit write failed")
            return _error(503, "감사 로그 기록에 실패하여 요청을 처리할 수 없습니다.")
        if not entry.allowed:
            if not ctx.groups:
                return _error(403, "소속 그룹이 없어 Agent를 사용할 수 없습니다. 관리자에게 그룹 배정을 요청하세요.")
            return _error(403, f"{permissions.agents[model].name} 사용 권한이 없습니다.")

        cited: list[str] = []
        events = _guarded(agent.run(messages, ctx), cited)
        completion = Completion(model)

        if body.get("stream"):

            async def sse():
                try:
                    yield completion.chunk({"role": "assistant", "content": ""})
                    async for event in events:
                        if event.type == "text":
                            yield completion.chunk({"content": event.content})
                        elif event.type == "status":
                            # Open WebUI renders reasoning_content as a collapsible "thinking" block.
                            yield completion.chunk({"reasoning_content": event.content + "\n"})
                    yield completion.chunk({}, finish_reason="stop")
                    yield "data: [DONE]\n\n"
                finally:
                    await audit.set_documents(entry_id, cited)

            return StreamingResponse(sse(), media_type="text/event-stream")

        text, reasoning = [], []
        async for event in events:
            if event.type == "text":
                text.append(event.content)
            elif event.type == "status":
                reasoning.append(event.content)
        await audit.set_documents(entry_id, cited)
        return completion.full("".join(text), "\n".join(reasoning))

    return app
