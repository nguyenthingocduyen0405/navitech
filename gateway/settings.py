import os
from dataclasses import dataclass

MIN_SECRET_LENGTH = 32


def _required(name: str, min_length: int = 1) -> str:
    value = os.environ.get(name, "").strip()
    if len(value) < min_length:
        raise RuntimeError(f"Environment variable {name} is missing or shorter than {min_length} chars")
    return value


@dataclass(frozen=True)
class Settings:
    backend_api_key: str  # shared with Open WebUI's connection config
    owui_jwt_secret: str  # = Open WebUI FORWARD_USER_INFO_HEADER_JWT_SECRET
    permissions_file: str
    app_database_url: str
    keycloak_url: str  # internal URL, e.g. http://keycloak:8080
    keycloak_realm: str
    keycloak_client_id: str
    keycloak_client_secret: str
    user_jwt_header: str = "X-OpenWebUI-User-Jwt"
    chat_id_header: str = "X-OpenWebUI-Chat-Id"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            backend_api_key=_required("BACKEND_API_KEY", MIN_SECRET_LENGTH),
            owui_jwt_secret=_required("OWUI_FORWARD_JWT_SECRET", MIN_SECRET_LENGTH),
            permissions_file=os.environ.get("PERMISSIONS_FILE", "config/permissions.yaml"),
            app_database_url=_required("APP_DATABASE_URL"),
            keycloak_url=_required("KEYCLOAK_INTERNAL_URL"),
            keycloak_realm=os.environ.get("KEYCLOAK_REALM", "capstone"),
            keycloak_client_id=os.environ.get("GATEWAY_KC_CLIENT_ID", "gateway"),
            keycloak_client_secret=_required("GATEWAY_KC_CLIENT_SECRET"),
        )
