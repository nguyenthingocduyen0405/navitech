"""Look up a user's current groups in Keycloak.

The JWT forwarded by Open WebUI only carries identity (email, name, role), not
groups, so the gateway asks Keycloak directly. Results are cached briefly, which
also means revoking a group takes effect within `cache_ttl` seconds — without
waiting for the user to log in again.
"""

import time
from dataclasses import dataclass
from typing import Protocol

import httpx


@dataclass(frozen=True)
class DirectoryUser:
    email: str
    name: str
    groups: frozenset[str]


class Directory(Protocol):
    async def lookup(self, email: str) -> DirectoryUser | None: ...

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
    ):
        self._realm = realm
        self._client_id = client_id
        self._client_secret = client_secret
        self._cache_ttl = cache_ttl
        self._http = httpx.AsyncClient(base_url=base_url, timeout=10.0)
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._cache: dict[str, tuple[float, DirectoryUser | None]] = {}

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
