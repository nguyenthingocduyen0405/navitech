"""Keycloak에서 사용자의 현재 그룹을 조회합니다.

Open WebUI가 전달하는 JWT에는 신원 정보(이메일, 이름, 역할)만 있고 그룹은 없으므로
Gateway가 Keycloak에 직접 물어봅니다. 결과는 잠시 캐시되며, 그 덕분에 그룹을 회수하면
사용자가 다시 로그인하지 않아도 `cache_ttl`초 안에 반영됩니다.

이름으로도 찾습니다 (`search_people`): 회의 기록에는 회의에서 불린 이름만 있으므로, Agent backend가
메일을 보낼 때 그 사람이 로그인할 때 등록한 이메일을 여기서 찾습니다. 회의지원 Agent는 찾은 주소로
승인 없이 메일을 보내므로, 관리자가 그룹을 배정한 계정만 답합니다: 자가 가입 계정은 이름을 마음대로
정할 수 있어서, 임원과 같은 이름으로 가입해 회의록을 받아 가는 일을 막기 위해서입니다.
"""

import re
import time
from dataclasses import dataclass
from typing import Protocol

import httpx


@dataclass(frozen=True)
class DirectoryUser:
    email: str
    name: str
    groups: frozenset[str]


@dataclass(frozen=True)
class DirectoryPerson:
    name: str
    email: str
    sub: str  # Keycloak 사용자 id


def name_key(text: str) -> str:
    return re.sub(r"\s+", "", text or "").lower()


def name_keys(first: str | None, last: str | None, username: str | None) -> set[str]:
    """한 사용자를 부를 수 있는 이름: 성+이름(한국어 순서), 이름+성, 로그인 id."""
    first, last = first or "", last or ""
    return {k for k in (name_key(last + first), name_key(first + last), name_key(username or "")) if k}


class Directory(Protocol):
    async def lookup(self, email: str) -> DirectoryUser | None: ...

    async def search_people(self, name: str) -> list[DirectoryPerson]: ...

    async def close(self) -> None: ...


class DirectoryUnavailable(Exception):
    pass


class KeycloakDirectory:
    def __init__(
        self,
        base_url: str,
        realm: str,
        client_id: str,
        client_secret: str,
        cache_ttl: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._realm = realm
        self._client_id = client_id
        self._client_secret = client_secret
        self._cache_ttl = cache_ttl
        self._http = httpx.AsyncClient(base_url=base_url, timeout=10.0, transport=transport)
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._cache: dict[str, tuple[float, DirectoryUser | None]] = {}
        self._people: tuple[float, list[dict]] = (0.0, [])

    async def close(self) -> None:
        await self._http.aclose()

    async def _admin_token(self) -> str:
        if self._token and time.monotonic() < self._token_expires_at:
            return self._token
        resp = await self._http.post(
            f"/realms/{self._realm}/protocol/openid-connect/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret,
            },
        )
        resp.raise_for_status()
        body = resp.json()
        self._token = body["access_token"]
        self._token_expires_at = time.monotonic() + body.get("expires_in", 60) - 30
        return self._token

    async def lookup(self, email: str) -> DirectoryUser | None:
        email = email.strip().lower()
        cached = self._cache.get(email)
        if cached and time.monotonic() < cached[0]:
            return cached[1]
        try:
            user = await self._fetch(email)
        except httpx.HTTPError as exc:
            raise DirectoryUnavailable(str(exc)) from exc
        self._cache[email] = (time.monotonic() + self._cache_ttl, user)
        return user

    async def search_people(self, name: str) -> list[DirectoryPerson]:
        """이름이 정확히 같은 활성 사용자 (공백 · 성과 이름 순서 무시). 이메일이 없거나 그룹이 하나도 없는
        (관리자가 배정하지 않은 자가 가입) 사용자는 제외."""
        key = name_key(name)
        if not key:
            return []
        try:
            users = await self._all_users()
            named = [u for u in users
                     if u.get("enabled") and u.get("email") and key in name_keys(u.get("firstName"), u.get("lastName"), u.get("username"))]
            assigned = [u for u in named if await self._has_groups(u["id"])]
        except httpx.HTTPError as exc:
            raise DirectoryUnavailable(str(exc)) from exc
        return [
            DirectoryPerson(" ".join(filter(None, [u.get("lastName"), u.get("firstName")])) or u["username"], u["email"], u["id"])
            for u in assigned
        ]

    async def _has_groups(self, user_id: str) -> bool:
        headers = {"Authorization": f"Bearer {await self._admin_token()}"}
        resp = await self._http.get(f"/admin/realms/{self._realm}/users/{user_id}/groups", params={"max": 1}, headers=headers)
        resp.raise_for_status()
        return bool(resp.json())

    async def _all_users(self) -> list[dict]:
        if time.monotonic() < self._people[0]:
            return self._people[1]
        headers = {"Authorization": f"Bearer {await self._admin_token()}"}
        resp = await self._http.get(
            f"/admin/realms/{self._realm}/users", params={"max": 2000, "briefRepresentation": "true"}, headers=headers
        )
        resp.raise_for_status()
        self._people = (time.monotonic() + self._cache_ttl, resp.json())
        return self._people[1]

    async def _fetch(self, email: str) -> DirectoryUser | None:
        headers = {"Authorization": f"Bearer {await self._admin_token()}"}
        base = f"/admin/realms/{self._realm}/users"
        resp = await self._http.get(base, params={"email": email, "exact": "true"}, headers=headers)
        resp.raise_for_status()
        matches = [u for u in resp.json() if u.get("enabled") and (u.get("email") or "").lower() == email]
        if not matches:
            return None
        kc_user = matches[0]
        resp = await self._http.get(f"{base}/{kc_user['id']}/groups", headers=headers)
        resp.raise_for_status()
        name = " ".join(filter(None, [kc_user.get("firstName"), kc_user.get("lastName")])) or kc_user["username"]
        return DirectoryUser(email=email, name=name, groups=frozenset(g["name"] for g in resp.json()))
