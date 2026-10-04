import secrets

import jwt

from gateway.directory import Directory
from gateway.permissions import Permissions
from shared.user_context import UserContext

OPENWEBUI_ISSUER = "open-webui"


class AuthError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def check_api_key(authorization: str | None, expected: str) -> None:
    """Only Open WebUI (and our own services) hold the backend API key."""
    presented = (authorization or "").encode()
    if not secrets.compare_digest(presented, f"Bearer {expected}".encode()):
        raise AuthError(401, "invalid API key")


def verify_openwebui_jwt(token: str | None, secret: str) -> dict:
    """Verify the HS256 JWT Open WebUI sends when FORWARD_USER_INFO_HEADER_JWT_SECRET is set.

    Plain X-OpenWebUI-User-* headers are deliberately not accepted: anyone who can
    reach the gateway could forge them.
    """
    if not token:
        raise AuthError(401, "missing user token")
    try:
        return jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            issuer=OPENWEBUI_ISSUER,
            options={"require": ["exp", "iat", "iss", "sub", "email"]},
        )
    except jwt.PyJWTError as exc:
        raise AuthError(401, f"invalid user token: {exc}") from exc


async def build_user_context(
    claims: dict,
    directory: Directory,
    permissions: Permissions,
    chat_id: str | None = None,
) -> UserContext:
    email = claims["email"].strip().lower()
    entry = await directory.lookup(email)
    groups = entry.groups if entry else frozenset()
    clearance, agents = permissions.resolve(groups)
    return UserContext(
        email=email,
        name=entry.name if entry else claims.get("name", ""),
        groups=groups,
        clearance=clearance,
        allowed_agents=agents,
        chat_id=chat_id,
    )
