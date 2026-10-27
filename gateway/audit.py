"""누가, 어떤 Agent로, 무엇을 물었고, 어떤 문서가 사용되었는지 기록합니다.

요청은 Agent 실행 *전에* 기록하며 (fail-closed: 기록 실패 시 답변 없음),
사용된 문서는 답변이 끝난 뒤 채워 넣습니다.
"""

import logging
from dataclasses import dataclass, field
from typing import Protocol

import asyncpg

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    email       TEXT NOT NULL,
    agent       TEXT NOT NULL,
    allowed     BOOLEAN NOT NULL,
    reason      TEXT,
    chat_id     TEXT,
    query       TEXT,
    doc_ids     TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_log_email_ts ON audit_log (email, ts DESC);
"""

MAX_QUERY_CHARS = 4000


@dataclass
class AuditEntry:
    email: str
    agent: str
    allowed: bool
    reason: str | None = None
    chat_id: str | None = None
    query: str = ""
    doc_ids: list[str] = field(default_factory=list)


class AuditLog(Protocol):
    async def start(self) -> None: ...

    async def close(self) -> None: ...

    async def record(self, entry: AuditEntry) -> int: ...

    async def set_documents(self, entry_id: int, doc_ids: list[str]) -> None: ...


class PostgresAuditLog:
    def __init__(self, dsn: str):
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None

    async def start(self) -> None:
        self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=5)
        async with self._pool.acquire() as conn:
            await conn.execute(SCHEMA)

    async def close(self) -> None:
        if self._pool:
            await self._pool.close()

    async def record(self, entry: AuditEntry) -> int:
        return await self._pool.fetchval(
            "INSERT INTO audit_log (email, agent, allowed, reason, chat_id, query, doc_ids)"
            " VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
            entry.email,
            entry.agent,
            entry.allowed,
            entry.reason,
            entry.chat_id,
            entry.query[:MAX_QUERY_CHARS],
            entry.doc_ids,
        )

    async def set_documents(self, entry_id: int, doc_ids: list[str]) -> None:
        try:
            await self._pool.execute("UPDATE audit_log SET doc_ids = $2 WHERE id = $1", entry_id, doc_ids)
        except Exception:
            log.exception("감사 로그 %s의 사용 문서 기록 실패", entry_id)


class MemoryAuditLog:
    """테스트 및 Postgres 없이 로컬 실행할 때 사용합니다."""

    def __init__(self):
        self.entries: list[AuditEntry] = []

    async def start(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def record(self, entry: AuditEntry) -> int:
        self.entries.append(entry)
        return len(self.entries) - 1

    async def set_documents(self, entry_id: int, doc_ids: list[str]) -> None:
        self.entries[entry_id].doc_ids = doc_ids
