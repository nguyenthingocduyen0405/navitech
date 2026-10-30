"""Open WebUI의 그룹과 모델 표시 권한을 config/permissions.yaml에 맞춥니다.

Open WebUI는 접근 권한이 부여된 모델만 일반 사용자에게 보여 주므로,
최초 실행 후와 permissions.yaml을 바꿀 때마다 실행합니다:

    docker compose exec -e OPENWEBUI_ADMIN_API_KEY=sk-... gateway python -m gateway.sync_openwebui

그룹 소속 자체는 로그인할 때마다 Keycloak에서 가져옵니다 (그룹 이름으로 매칭).
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
        sys.exit("OPENWEBUI_ADMIN_API_KEY를 설정하세요 (관리자 계정으로 Open WebUI > 설정 > 계정 > API 키에서 발급)")

    with httpx.Client(base_url=base_url, headers={"Authorization": f"Bearer {api_key}"}, timeout=30) as client:
        groups = {g["name"]: g for g in _ok(client.get("/api/v1/groups/")).json()}
        for name, policy in permissions.groups.items():
            if name not in groups:
                created = _ok(
                    client.post("/api/v1/groups/create", json={"name": name, "description": policy.description})
                ).json()
                groups[name] = created
                print(f"그룹 생성: {name}")

        for agent in permissions.agents.values():
            readers = [name for name, policy in permissions.groups.items() if agent.id in policy.agents]
            grants = [
                {"principal_type": "group", "principal_id": groups[name]["id"], "permission": "read"}
                for name in readers
            ]
            # 모델 항목이 없으면 먼저 만들고, 이름과 설명을 설정합니다.
            _ok(client.post("/api/v1/models/model/access/update", json={"id": agent.id, "name": agent.name, "access_grants": grants}))
            _ok(
                client.post(
                    "/api/v1/models/model/update",
                    json={
                        "id": agent.id,
                        "name": agent.name,
                        "meta": {
                            "description": agent.description,
                            # 새 채팅 화면의 제안 (비우면 Open WebUI 기본 영어 제안이 보임)
                            "suggestion_prompts": [{"title": [t, p], "content": p} for t, p in agent.suggestions],
                        },
                        "params": {},
                        "access_grants": grants,
                    },
                )
            )
            print(f"{agent.id}: 표시 대상 그룹 → {', '.join(readers) or '(없음)'}")


if __name__ == "__main__":
    main()
