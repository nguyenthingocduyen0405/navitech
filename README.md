# navitech — C-Level AI Agent (SK × JBNU 캡스톤)

**SSO 로그인(Keycloak) → Open WebUI → Gateway(권한 검사·감사 로그) → 4종 Agent**가 처음부터 끝까지 동작합니다.
Agent는 **Agent backend**(`agent-backend/` = [flopsoda/capstone_demo](https://github.com/flopsoda/capstone_demo), LangGraph + Ollama Cloud)의 실제 Agent입니다.
Open WebUI의 4개 모델은 backend의 **Group Agent System**에 연결되고, 그룹 슈퍼에이전트는 필요하면 **K전자 Agent System**에 A2A로 검토를 요청합니다.

```
Open WebUI ── 4개 중 선택: Super Agent | 경영자문 | 뉴스 Briefing | 회의지원
     │  OpenAI API  +  X-OpenWebUI-User-Jwt (HS256 서명 JWT)
     ▼
Gateway (FastAPI)  gateway/
  1. API 키 확인  →  2. JWT 검증  →  3. Keycloak에서 그룹 조회
  4. UserContext 생성 + 권한 검사 (config/permissions.yaml)  →  5. audit_log 기록
     │
     │  agents/remote.py: POST /api/agents/{id}/run (NDJSON 이벤트 스트림)
     ▼
agents-group (Group Agent System, :8001 내부)
     ├── super-agent    ──► 그룹 슈퍼에이전트 ──┬─ 위임 ─► 그룹 미팅 / 뉴스 / 경영자문 에이전트
     │                                          └─ A2A ──► agents-k (K전자 Agent System, :8000 내부)
     │                                                       K전자 슈퍼에이전트 ─ 위임 ─► 미팅 / 뉴스 / 경영자문
     ├── advisory-agent ──► 그룹 경영자문 에이전트 (run_mna_review)
     ├── news-agent     ──► 그룹 뉴스 에이전트 (run_company_risk_news_analysis)
     └── meeting-agent  ──► 그룹 미팅 에이전트 (run_meeting_context_retrieval)
                                              │
                                              ▼
                              Ollama Cloud LLM · fixture 데이터 (agent-backend/backend/app/systems/*/data)
```

Gateway가 backend 이벤트를 OpenAI 스트림으로 바꿉니다: 호출한 Agent 자신의 답변 토큰 → 답변,
위임 · A2A · Workflow Tool 진행 상황 → 접을 수 있는 "생각" 블록, Workflow 결과의 회의 · 기사 id → 감사 로그.
Super Agent가 사용자에게 권한이 없는 전문 Agent(K전자 쪽 포함)에게 위임하려 하면 Gateway가 그 시점에 응답을 끊습니다.

## 디렉터리 구성

| 경로 | 내용 | 담당 |
|---|---|---|
| `config/permissions.yaml` | 권한의 **단일 기준**: 그룹 → 열람 등급, 사용 가능한 Agent | Auth |
| `gateway/` | OpenAI 호환 API, 인증, 권한 검사, 감사 로그, Open WebUI 동기화 스크립트 | Auth |
| `admin-portal/` | 사용자 · 권한 관리 페이지 (정적 HTML/JS, Keycloak Admin API 호출) | Auth |
| `infra/keycloak/import/capstone-realm.json` | Realm, 역할, 그룹, 클라이언트, 데모 계정 | Auth |
| `shared/user_context.py` | `UserContext` — 모든 Agent / 도구에 전달 | 공통 |
| `shared/access.py` | RAG / 온톨로지용 권한 기반 데이터 필터 규칙 | 공통 (Auth + RAG) |
| `agents/base.py` | `Agent.run(messages, ctx, task)` 인터페이스와 `AgentEvent` | Agent |
| `agents/remote.py` | 실제 Agent: Agent backend 호출 + 이벤트 변환 + 위임 권한 검사 | Agent |
| `agents/mock.py`, `agents/super_agent.py` | 가짜 Agent — `AGENT_BACKEND_URL`이 비어 있을 때 (테스트, 로컬 실행) | Agent |
| `agent-backend/` | Agent backend 저장소 (flopsoda/capstone_demo, private) — `backend/`만 이미지로 빌드 | Agent |
| `infra/agent-backend/Dockerfile` | Agent backend 이미지. `agents-k`, `agents-group` 두 서비스가 같은 Dockerfile 사용 | Agent |
| `tests/` | Gateway 보안 테스트 | Auth |

## 서버에서 실행

```bash
# 인스턴스에서
cd ~/capstone-agent
python3 scripts/gen_env.py          # 최초 1회: 무작위 시크릿으로 .env 생성
# Agent backend: agent-backend/ 에 flopsoda/capstone_demo 저장소 (private → 접근 권한 있는 PC에서 git bundle로 복사)
# .env 에 OLLAMA_API_KEY=... 추가 (https://ollama.com/settings/keys). 없으면 Agent가 오류 메시지로 답합니다.
sudo docker compose up -d --build
sudo docker compose ps              # keycloak이 "healthy"가 될 때까지 대기 (~1분)
```

모든 포트는 서버의 `127.0.0.1`에만 열려 있습니다. 개인 PC에서 **SSH 터널**을 연 뒤 로컬처럼 브라우저로 접속합니다.

```bash
ssh -i <key.pem> -p <SSH_PORT> -N -L 3000:127.0.0.1:3000 -L 3001:127.0.0.1:3001 -L 8080:127.0.0.1:8080 ubuntu@<SERVER_IP>
```

> 서버 주소, SSH 포트, 키 파일은 팀 내부에서 따로 공유합니다 — 저장소(public)에 적지 않습니다.

- Open WebUI: http://localhost:3000
- **사용자 · 권한 관리: http://localhost:3001** (`admin` 역할 계정)
- Keycloak 관리 콘솔: http://localhost:8080/admin (사용자 `kcadmin`, 비밀번호는 `.env`의 `KEYCLOAK_ADMIN_PASSWORD`) — realm 설정을 바꿀 때만 사용

### 데모 계정

공통 비밀번호: `grep DEMO_USER_PASSWORD ~/capstone-agent/.env`

| 로그인 | 역할 | 그룹 | 열람 등급 | 사용 가능한 Agent |
|---|---|---|---|---|
| `ceo` | user | executive | 4 (극비) | 4종 모두 |
| `secretary` | user | secretary | 3 (대외비) | Super, 뉴스, 회의지원 |
| `staff` | user | staff | 2 (사내) | 4종 모두 |
| `sysadmin` | **admin** | developer | 1 (공개) | 4종 모두 + 사용자 관리 |

### 권한 체계: 서로 독립된 두 축

- **역할 (Keycloak role)** — 시스템을 누가 관리하는가. `user`: 로그인 가능. `admin`: 사용자·그룹 관리. **`admin` 역할만으로는 Agent 사용이나 자료 열람 권한이 생기지 않습니다.**
- **그룹 (`config/permissions.yaml`)** — 어떤 Agent를 쓰고, 어느 등급의 자료까지 볼 수 있는가.

한 사람 = 역할 1개 + 그룹 1개 이상 (그룹이 여러 개면 가장 높은 열람 등급, Agent는 합집합).
개발팀 구성원 → `developer` 그룹: 모든 Agent를 테스트할 수 있지만 공개 자료만 볼 수 있습니다.
그룹이 없는 사용자에게는 "소속 그룹이 없어 Agent를 사용할 수 없습니다…" 메시지가 표시됩니다.

### 최초 1회: Open WebUI로 권한 동기화

Open WebUI는 권한이 부여된 모델만 일반 사용자에게 보여 줍니다. 처음 실행한 뒤:

1. **가장 먼저** `sysadmin`으로 Open WebUI에 로그인합니다 (최초 로그인 사용자가 Open WebUI 관리자가 됨) → **설정 → 계정 → API 키**에서 키 생성.
2. 다음 명령 실행:
   ```bash
   sudo docker compose exec -e OPENWEBUI_ADMIN_API_KEY=sk-... gateway python -m gateway.sync_openwebui
   ```
3. 다른 사용자는 **다시 로그인**해야 Open WebUI가 Keycloak 그룹을 반영합니다.

## 화면 디자인

로그인 페이지(Keycloak), 사용자 · 권한 관리 페이지, Open WebUI가 같은 브랜드 색상(indigo → violet → fuchsia 그라데이션)과 Pretendard 글꼴을 사용하며, 시스템의 라이트/다크 모드를 따릅니다.

**브랜드 색상 변경:** 다음 3개 파일 맨 위의 그라데이션/브랜드 변수를 수정합니다 — `capstone.css` (`--cap-gradient`, `--cap-brand`…), `admin-portal/style.css` (`--gradient`, `--brand`…), `infra/open-webui/custom.css` (`--cap-gradient`…). 열람 등급 색상(공개 초록 · 사내 파랑 · 대외비 주황 · 극비 빨강)은 배지와 그룹 표시에 함께 쓰입니다.

| 파일 | 역할 |
|---|---|
| `infra/keycloak/themes/capstone/login/resources/css/capstone.css` | 로그인 테마 `capstone` (`keycloak.v2` 상속). 수정 후 페이지 새로고침만 하면 됨 (dev 모드는 테마 캐시 없음) |
| `infra/open-webui/custom.css` | Open WebUI의 글꼴·글자 크기(기본 10% 확대)·색상·테두리. 수정 후 `sudo docker compose restart open-webui` |

- `OAUTH_AUTO_REDIRECT=true`: Open WebUI 자체 로그인 화면을 건너뛰고 공통 로그인 페이지로 바로 이동합니다.
- 각 사용자는 **설정 → 인터페이스 → UI Scale**에서 글자 크기를 추가로 조절할 수 있습니다 (기본값에 곱해짐).
- "Open WebUI" 이름과 로고는 Open WebUI 라이선스에 따라 유지합니다 (30일 기준 사용자 50명 이하이거나 엔터프라이즈 라이선스가 있어야 제거 가능).
- 글꼴은 jsDelivr CDN에서 불러오며, 사내망에서 CDN이 막히면 시스템 글꼴로 표시됩니다.

## Agent backend 업데이트

```bash
# 저장소 접근 권한이 있는 PC에서
git -C capstone_demo pull && git -C capstone_demo bundle create capstone_demo.bundle --all
scp -P <SSH_PORT> capstone_demo.bundle ubuntu@<SERVER_IP>:/tmp/
# 서버에서
cd ~/capstone-agent/agent-backend && git pull /tmp/capstone_demo.bundle main
cd .. && sudo docker compose up -d --build agents-k agents-group
```

LLM 모델 변경: `.env`의 `OLLAMA_MODEL` (기본 `deepseek-v4.1-flash`) 수정 후 `docker compose up -d agents-k agents-group`.

## 권한 체계 변경

1. `config/permissions.yaml` 수정 (그룹, 열람 등급, Agent).
2. 새 그룹 → Keycloak에 같은 이름의 그룹을 만들고 사용자를 추가.
3. `sudo docker compose restart gateway` 후 위의 동기화 단계를 다시 실행.

## 사용자 관리

**사용자 · 권한 관리 페이지: http://localhost:3001** (`admin-portal/`) — `admin` 역할 계정(예: `sysadmin`)으로 로그인합니다.

| 작업 | 페이지에서 |
|---|---|
| 사용자·권한·열람 등급 확인 | **사용자** 표 |
| 권한 변경 | **권한 변경** → 그룹 선택 (그룹별 Agent와 열람 등급 설명 표시), *시스템 관리자*, *계정 활성화* 켜기/끄기 (끄면 즉시 로그아웃) |
| 사용자 추가 | **+ 사용자 추가** → 임시 비밀번호 생성 (한 번만 표시), 첫 로그인 때 변경 필수 |
| 권한 체계 확인 | **권한 체계** 표 (`config/permissions.yaml`을 읽어 표시) |

- 페이지는 로그인한 관리자 본인의 토큰으로 Keycloak Admin API를 직접 호출합니다 → Keycloak이 권한을 직접 검사하고, 변경 이력에 실제 수정자가 남습니다. `admin` 역할이 없는 사용자에게는 "시스템 관리자만 사용할 수 있습니다" 안내만 표시됩니다.
- 자기 자신의 관리자 권한 해제·계정 비활성화는 할 수 없습니다 (스스로 잠기는 것 방지).
- 극비 등급 그룹을 부여할 때는 한 번 더 확인합니다.
- Gateway는 변경된 권한을 바로(최대 60초) 적용하며, Open WebUI의 Agent 목록은 사용자가 다시 로그인하면 갱신됩니다.
- 사용자 완전 삭제 / 비밀번호 초기화: Keycloak 콘솔 http://localhost:8080/admin/capstone/console/ (`sysadmin`으로 로그인).

- 모든 사용자/그룹 변경은 기록됩니다 (**Events → Admin events**), 로그인 기록은 **Events → User events** (90일 보관).
- Open WebUI 관리자 화면에서 역할/그룹을 **바꾸지 마세요** — 로그인할 때마다 Keycloak 기준으로 덮어씁니다.
- `kcadmin` (`master` realm)은 Keycloak 전체의 슈퍼 관리자입니다 — realm 설정을 바꿀 때만 사용합니다.

> `capstone-realm.json`은 realm이 **아직 없을 때만** import됩니다. 최초 실행 이후 이 파일을 수정해도 반영되지 않으므로 관리 콘솔에서 수정하거나, 볼륨을 지우고 다시 import해야 합니다.

## 팀원별 연동 규약

**Agent** — `agents/base.py`의 인터페이스를 구현하고 `agents/registry.py`에 등록합니다.
- `run()`의 첫 줄에서 `require_access(ctx, self.id)`를 호출합니다.
- 모든 도구에 `ctx`를 전달합니다. 권한은 프롬프트가 아니라 **코드로** 검사합니다.
- `AgentEvent.text`(답변), `.status`(진행 상황 — "생각" 블록에 표시), `.citation`(사용한 문서 id — 감사 로그에 기록)을 반환합니다.
- 하위 Agent는 단독으로 동작해야 합니다 (Super Agent를 거치지 않고 직접 호출될 수 있음).

**RAG / 온톨로지** — 모든 chunk / node에 `shared/access.py`에 정의된 메타데이터
(`classification` 1–4, `allowed_groups`, `meeting_id`, `source`)를 붙이고, 유사도 검색 **이전에** 쿼리 **안에서** `retrieval_filter(ctx)`를 적용합니다.

## 보안 참고 사항

- Gateway는 Open WebUI가 서명한 JWT(`X-OpenWebUI-User-Jwt`)만 신뢰하며, 일반 `X-OpenWebUI-User-*` 헤더는 신뢰하지 않습니다.
- Open WebUI는 SSO 로그인만 허용합니다. `ENABLE_LOGIN_FORM` / `ENABLE_SIGNUP`을 **켜지 마세요**: 임원과 같은 이메일의 로컬 계정이 생기면 Gateway가 그 계정을 임원으로 간주합니다.
- 감사 로그는 Agent 실행 전에 기록하며, 기록에 실패하면 요청을 거부합니다.
- Open WebUI 관리자는 다른 사람의 채팅을 볼 수 없습니다 (`ENABLE_ADMIN_CHAT_ACCESS=false`).
- `start-dev` + HTTP는 SSH 터널을 통한 개발용입니다. 인터넷에 공개하려면 HTTPS + `kc.sh start`가 필요합니다.

## 테스트

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt   # Windows
.venv/Scripts/python -m pytest -q
```

## 다음 작업 (Auth)

- [ ] 도메인 + HTTPS(리버스 프록시/Cloudflare Tunnel)로 터널 없이 팀원·멘토 접속
- [ ] 대시보드 Keycloak 로그인, Gateway에서 Keycloak access token 검증 (JWKS)
- [ ] 회의 참석자 데이터로 `UserContext`의 `meeting_ids` 채우기
- [ ] 텔레그램 계정 연동
- [ ] 실제 Agent 대상 프롬프트 인젝션 / 권한 우회 테스트
