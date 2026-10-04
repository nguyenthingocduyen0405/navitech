"""Make Open WebUI's groups and model visibility match config/permissions.yaml.

Open WebUI only shows a connection model to non-admin users once it has an access
grant, so run this after first start and after every change to permissions.yaml:

    docker compose exec -e OPENWEBUI_ADMIN_API_KEY=sk-... gateway python -m gateway.sync_openwebui

Group membership itself comes from Keycloak on each login (groups are matched by name).
"""

import os
import sys

import httpx

from gateway.permissions import Permissions


def _ok(resp: httpx.Response) -> httpx.Response:
    if resp.is_error:
        sys.exit(f"{resp.request.method} {resp.request.url.path} -> {resp.status_code}: {resp.text}")
    return resp


def main() -> None:
    permissions = Permissions.load(os.environ.get("PERMISSIONS_FILE", "config/permissions.yaml"))
    base_url = os.environ.get("OPENWEBUI_INTERNAL_URL", "http://open-webui:8080")
    api_key = os.environ.get("OPENWEBUI_ADMIN_API_KEY")
    if not api_key:
        sys.exit("Set OPENWEBUI_ADMIN_API_KEY (Open WebUI > Settings > Account > API Keys, as an admin)")

    with httpx.Client(base_url=base_url, headers={"Authorization": f"Bearer {api_key}"}, timeout=30) as client:
        groups = {g["name"]: g for g in _ok(client.get("/api/v1/groups/")).json()}
        for name, policy in permissions.groups.items():
            if name not in groups:
                created = _ok(
                    client.post("/api/v1/groups/create", json={"name": name, "description": policy.description})
                ).json()
                groups[name] = created
                print(f"created group {name}")

        for agent in permissions.agents.values():
            readers = [name for name, policy in permissions.groups.items() if agent.id in policy.agents]
            grants = [
                {"principal_type": "group", "principal_id": groups[name]["id"], "permission": "read"}
                for name in readers
            ]
            # Creates the model entry if it does not exist yet, then sets name/description.
            _ok(client.post("/api/v1/models/model/access/update", json={"id": agent.id, "name": agent.name, "access_grants": grants}))
            _ok(
                client.post(
                    "/api/v1/models/model/update",
                    json={
                        "id": agent.id,
                        "name": agent.name,
                        "meta": {"description": agent.description},
                        "params": {},
                        "access_grants": grants,
                    },
                )
            )
            print(f"{agent.id}: visible to {', '.join(readers) or '(nobody)'}")


if __name__ == "__main__":
    main()
