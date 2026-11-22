# navitech — C-Level AI Agent (SK × JBNU 캡스톤)

**SSO 로그인(Keycloak) → Open WebUI → Gateway(권한 검사·감사 로그) → 4종 Agent**가 처음부터 끝까지 동작합니다.
Agent는 **Agent backend**(`agent-backend/` = [flopsoda/capstone_demo](https://github.com/flopsoda/capstone_demo), LangGraph + Ollama Cloud)의 실제 Agent입니다.
Open WebUI의 4개 모델은 backend의 **Group Agent System**에 연결되고, 그룹 슈퍼에이전트는 필요하면 **K전자 Agent System**에 A2A로 검토를 요청하거나 업무를 전달합니다.

```
Open WebUI ── 왼쪽 메뉴에서 선택: Super Agent | 경영자문 | 뉴스 Briefing | 회의지원
     │  OpenAI API  +  X-OpenWebUI-User-Jwt (HS256 서명 JWT)
     ▼
Gateway (FastAPI)  gateway/
  1. API 키 확인  →  2. JWT 검증  →  3. Keycloak에서 그룹 조회
  4. UserContext 생성 + 권한 검사 (config/permissions.yaml)  →  5. audit_log 기록
     │
     │  agents/remote.py: POST /api/agents/{id}/run (NDJSON 이벤트 스트림) + principal_token (요청자를 HS256 서명)
     ▼
agents-group (Group Agent System, :8001 내부)
     ├── super-agent    ──► 그룹 슈퍼에이전트 ──┬─ 위임 ─► 그룹 미팅 / 뉴스 / 경영자문 에이전트
     │                                          └─ A2A ──► agents-k (K전자 Agent System, :8000 내부)
     │                                                       K전자 슈퍼에이전트 ─ 위임 ─► 미팅 / 뉴스 / 경영자문 (경영자문은 미팅 · 뉴스에 조회 전용으로 직접 물음)
     ├── advisory-agent ──► 그룹 경영자문 에이전트 (지식 그래프 · 미팅/뉴스 조회 → 계산 → 판단 기록 → 투자심의 보고서)
     ├── news-agent     ──► 그룹 뉴스 에이전트 (run_company_risk_news_analysis)
     └── meeting-agent  ──► 그룹 미팅 에이전트 (회의록 · Action Item · 일정 · 메일 발송함)
                                              │
                                              ▼
                              Ollama Cloud LLM · fixture 데이터 (agent-backend/backend/app/systems/*/data)
```

Gateway가 backend 이벤트를 OpenAI 스트림으로 바꿉니다: 호출한 Agent 자신의 답변 토큰 → 답변,
위임 · A2A · Workflow Tool 진행 상황 → 접을 수 있는 "생각" 블록, Workflow 결과의 회의 · 기사 id → 감사 로그.
Gateway는 사용자가 쓸 수 있는 전문 Agent 목록을 principal에 담아 보내므로, Super Agent는 권한 없는 전문 Agent(K전자 쪽 포함)는 건너뛰고
("사용 권한 없음 → 건너뜀") 나머지 결과로 답합니다. 그래도 권한 없는 위임이 시작되면 Gateway가 그 시점에 응답을 끊습니다 (안전장치).
경영자문 에이전트가 판단을 저장하며 돌려준 **투자심의 보고서 참조**(K전자 것은 Group의 `a2a_end.artifacts`)는 답변 끝의 **보고서 카드**가 되고,
카드의 '보고서 열기' · 'PDF 내려받기'는 `POST /meetings/reports`(gateway/reports.py → Group backend `POST /api/reports`)로 PDF를 받습니다 —
파일은 Agent 사이에 오가지 않고, 열 때 backend가 그 사용자의 권한(경영자문 Agent 권한 + 보고서가 인용한 회의의 열람 등급)으로 만듭니다.
Agent 전환은 Open WebUI 왼쪽 메뉴의 고정 목록(`DEFAULT_PINNED_MODELS`)에서 하고, 입력창의 모델 선택 버튼은 숨깁니다 (`infra/open-webui/custom.css`).

### 회의지원 Agent의 회의 전 · 중 · 후 (2026-10-28)

| 기능 | 어디서 | 설정 |
|---|---|---|
| 회의 녹음 → 화자 라벨 transcript | speech-service: 첫 줄에 `[transcript_id: TR-…]`, 30일 보관 | `TRANSCRIPT_RETENTION_DAYS` |
| transcript를 회의에 연결 (발언 원문 · 근거 발언 링크) | 미팅 에이전트가 id로 speech-service에서 가져와 1년 보관 | `MEETINGS_TRANSCRIPT_RETENTION_DAYS` |
| 위험 발언 표시 → 간사 검토 후 확정 | 규칙(자본시장법 · 공정거래법 · 청탁금지법 · 외부감사법 · 노동조합법 · 개인정보) | — |
| 확정 · 정정 · 검토 · 메일 재발송 · 취소 · 업무 접수 권한 | 회의의 의장 · 간사 + 그룹 | `MEETINGS_CONFIRM_GROUPS` (기본 `secretary,executive`) |
| 메일: 회의록 · 업무 배정 · 회의 안내 · 기한 알림(D-3 · D-1 · 당일 · 경과) | 회의지원 Agent가 받는 사람의 주소를 찾아(Keycloak 등록 이메일 → 임직원 · 외부 연락처) 승인 없이 바로 SMTP로 발송. 못 찾으면 매일 다시 찾음 | `SMTP_*` (비면 메일은 발송 대기) |
| 그룹 → K전자 업무 전달 | Super Agent가 A2A로 전달 → K전자 쪽에 접수 대기로 남음 (배포 화면에는 K전자 확인 창구가 없음) | — |
| 녹음 파일 보존 기간 | `retention` 서비스가 Open WebUI 업로드의 녹음(wav · mp3 · json)을 삭제 | `AUDIO_RETENTION_DAYS` (30) |

- backend는 gateway가 `PRINCIPAL_SIGNING_KEY`로 서명한 요청자만 믿습니다 (서명 없이 사용자를 보내면 401). Group → K A2A도 같은 서명을 그대로 전달합니다.
- 메일 받는 사람의 주소는 backend가 gateway의 내부 API `GET /internal/directory/people?name=`(Bearer `INTERNAL_API_KEY`)로 찾습니다. 이름이 정확히 한 명일 때만 쓰고,
  못 찾으면 "주소 필요"로 남겨 간사가 알려 주게 합니다. 공개 nginx(`api.` 호스트)는 `/internal/`을 막습니다.
- 메일 발송 계정 (예: Gmail 앱 비밀번호): `.env`에 `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` → `docker compose up -d agents-k agents-group`.
- 회의 기록을 예시 회의 없이 빈 채로 시작하려면 `.env`에 `MEETINGS_SEED_MEETINGS=0` (저장소가 비었을 때 `data/meetings.json`의 예시 회의를 넣지 않음, 임직원 연락처는 넣음).

### 뉴스 Agent의 저장소와 파이프라인

뉴스 에이전트는 언론사 RSS · 뉴스 sitemap에서 기사를 모아 같은 사안끼리 묶고, 기사별 논조 · 리스크를 분석해 저장합니다.
회의 저장소와 **같은 DB `agents`**를 쓰되 schema를 따로 둡니다 (K `kelec_news`, Group `grp_news`) — `infra/postgres/init.sh`가
role별 소유로 미리 만들고, 테이블은 backend가 처음 쓸 때 만듭니다. 각 system은 처음 쓸 때 `data/news.json`의 기사를 초기 데이터로 등록합니다.

| 설정 | 기본값 | 뜻 |
|---|---|---|
| `NEWS_DATABASE_URL` | (비움) | 비우면 `MEETINGS_DATABASE_URL`과 같은 DB를 쓴다 |
| `NEWS_LOOKBACK_DAYS` | 120 | 뉴스 조회 기본 · 최대 기간(일) |
| `NEWS_EMBED_MODEL` | `none` | `none`이면 키워드 검색만. `embeddinggemma`로 바꾸면 의미 검색을 함께 쓴다(하이브리드) |
| `NEWS_EMBED_URL` | (비움) | 임베딩을 서빙하는 Ollama 주소 (예: `http://ollama:11434`) |

- 의미 검색은 **이 배포에 Ollama가 없어 기본으로 꺼져 있습니다**. 켜려면 Ollama를 띄우고 `ollama pull embeddinggemma` 뒤에
  `.env`의 `NEWS_EMBED_MODEL` · `NEWS_EMBED_URL`을 채우세요. 모델에 닿지 못하면 키워드 검색으로 스스로 되돌아갑니다.
- pgvector 확장은 `agents` DB에 미리 만들어 둡니다 (확장 생성은 superuser만 가능). Postgres 이미지는 `pgvector/pgvector:pg17`입니다.

> **이미 돌고 있던 서버라면 한 번 직접 실행해야 합니다.**
> `infra/postgres/init.sh`는 `/docker-entrypoint-initdb.d/`에 마운트되어 **`pgdata` 볼륨이 비어 있을 때만** 실행됩니다.
> 기존 배포에는 다시 돌지 않으므로, 뉴스 요청이 `뉴스 저장소에 pgvector 확장이 없습니다` 또는 권한 오류로 실패합니다
> (`agents_k` · `agents_group`에는 DB에 CREATE 권한이 없고, 확장 생성은 superuser만 할 수 있습니다).
>
> ```bash
> docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d agents <<'SQL'
> CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
> CREATE SCHEMA IF NOT EXISTS kelec_news AUTHORIZATION agents_k;
> CREATE SCHEMA IF NOT EXISTS grp_news AUTHORIZATION agents_group;
> SQL
> docker compose up -d agents-k agents-group
> ```
>
> 테이블은 backend가 처음 쓸 때 스스로 만듭니다 (`news/sql/NNN_*.sql`).

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
| `agents/remote.py` | 실제 Agent: Agent backend 호출 + 이벤트 변환 + 위임 권한 검사, 회의 Tool 결과 · 경영자문의 보고서 참조 → 답변 끝 카드 블록 (보고서 참조는 `report` 카드 — K전자 것은 relay된 Tool 결과가 아니라 Group의 `a2a_end.artifacts`에서 한 번만; 같은 종류 목록은 뒤의 것, 할 일을 하나씩 바꾸거나 메일을 보낸 결과는 합침; 예약 전 점검(schedule draft)은 내용을 그대로 담은 `schedule_form` 카드 — 같은 답변에서 예약까지 했으면 빼고, 양식이 있으면 날짜 계산용 일정 목록은 뺌) | Agent |
| `gateway/reports.py` | **투자심의 보고서** `POST /meetings/reports` `{system, id}` — 채팅의 보고서 카드가 부름. Open WebUI 로그인 토큰 → 경영자문 Agent 권한 확인 → 감사 로그 `[보고서] system id` → Group backend `POST /api/reports`(principal + 서명 토큰, K전자 보고서는 backend가 A2A로 가져옴) → PDF. nginx가 `/meetings/`만 gateway로 보내므로 그 아래 경로 | Agent |
| `agents/mock.py`, `agents/super_agent.py` | 가짜 Agent — `AGENT_BACKEND_URL`이 비어 있을 때 (테스트, 로컬 실행) | Agent |
| `agent-backend/` | Agent backend 저장소 (flopsoda/capstone_demo, private) — `backend/`만 이미지로 빌드 | Agent |
| `infra/agent-backend/Dockerfile` | Agent backend 이미지. `agents-k`, `agents-group` 두 서비스가 같은 Dockerfile 사용 | Agent |
| `infra/speech-service/` | 화자 식별 STT, 음성 등록 페이지 `/voice/`, 회의 transcript를 id로 보관 (`GET /internal/transcripts/{id}`) | 회의 |
| `infra/retention/` | Open WebUI가 보관하는 회의 녹음 파일을 보존 기간 후 삭제 | 회의 |
| `gateway/recording.py` | **회의 관제에서 녹음 받기** `/meetings/api/recording/transcribe`(녹음 → speech-service 받아쓰기 · 발언자 식별) · `/recording/minutes`(회의지원 Agent에게 채팅과 같은 요청, 진행을 NDJSON으로 흘려보냄). 권한은 회의 업무 화면과 같음, 확정 · 메일은 desk `finalize`(Agent 없이) | 회의 |
| `gateway/mail_action.py` | **메일로 진행 보고** `/meetings/act/<token>` — 업무 배정 · 기한 알림 · 독촉 메일의 버튼(완료 · 진행 중 · 막힘)이 여는 화면. 로그인 없음(외부 담당자도): token은 backend가 할 일 · 받는 사람 · 30일로 서명(`PRINCIPAL_SIGNING_KEY`), 확인도 backend(`/api/mail-action`). 여는 것(GET)은 보여 주기만, '보내기'(POST)를 눌러야 기록 (메일 보안 검사가 링크를 미리 열기 때문). 막힘은 이유 필수, 감사 로그에 남김. 버튼 주소는 agents-group의 `MEETINGS_ACTION_URL`(= `OPENWEBUI_PUBLIC_URL/meetings/act`) | 회의 |
| `gateway/desk.py`, `gateway/static/meetings/` | **회의 업무 API** `/meetings/api/*` — 채팅의 회의 카드가 씁니다. **회의 업무 화면** `/meetings/`(왼쪽 메뉴 '회의 업무'): `index.html`은 틀만 두고 내용은 채팅의 회의 카드와 같은 코드 `infra/open-webui/loader.js`(`/static/loader.js`)가 그림: 회의록 목록 · 상세(회의록 · 회의 결과 보고서 PDF 내려받기, 감사 로그 기록), Agent가 보낸 메일 기록(실패하면 다시 보내기), Compliance 검토, Action Item 완료를 버튼으로 (Agent 없이 backend `/api/desk/*`). Open WebUI 로그인 토큰으로 사용자를 확인하고 회의지원 Agent 권한이 있어야 열림. 왼쪽 메뉴 링크는 `infra/open-webui/loader.js`. **출석 확인**: 녹음을 올리면 채팅 화면에 30초마다 바뀌는 QR(`checkin`, segno SVG, `PUBLIC_URL`) → 휴대폰 `/meetings/checkin/`에서 같은 로그인으로 출석(그룹이 배정된 회사 계정이면 누구나). 회의 카드의 참석자 고르기는 Keycloak 계정 찾기(`people`), 고른 이메일은 회사 계정인지 확인한 뒤 backend로. **목소리 구분 확인** `/meetings/voice-check/`: 녹음을 올리면 왼쪽에 녹음, 오른쪽에 '이름: 발언' (발언을 누르면 그 시각부터 재생, ✓ · ✗로 채점) — 지금 모델이 발언자를 얼마나 잘 나누는지 듣고 확인하는 화면, 발언자를 나누는 방식(지금 방식 · pyannote)을 골라 같은 녹음을 비교, `gateway/voice_check.py` → speech-service `/internal/review`, 저장 · 학습 없음 | 회의 |
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
| `ceo` | user | executive | 4 (극비) | 4종 모두 (회의록 확정 · 메일 재발송 가능) |
| `secretary` | user | secretary | 3 (대외비) | Super, 뉴스, 회의지원 (회의록 확정 · 메일 재발송 가능) |
| `staff` | user | staff | 2 (사내) | 4종 모두 (회의록은 초안까지) |
| `sysadmin` | **admin** | developer | 1 (공개) | 4종 모두 + 사용자 관리 (회의록은 초안까지) |

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
| `infra/open-webui/loader.js` | Open WebUI에 끼워 넣는 스크립트: 'Agent 목록' 제목, **회의 카드** — gateway가 회의 Tool 결과로 답변 끝에 붙인 ```navitech 블록(회의록 · 일정 · 할 일 · 메일)을 버튼 있는 카드로 바꾸고(PDF · 완료 · 다시 보내기 · 위험 발언 검토 · 확정 요청 · 이 회의 녹음 시작), 왼쪽 메뉴 '노트' 아래 **'회의 업무'** 링크와 그 화면 `/meetings/` — 위 회의록 검색 · 왼쪽 메뉴(구역별 건수) · 본문: **관제**(오늘 띠: 오늘 회의 몇 건 · 끝남 · 진행 중 · 남음 · 다음 회의까지, 보기 목록 · 주(시간 칸에 회의 블록, 지금 시각 빨간 선, 겹치면 나란히) · 월(날마다 3건 + n, 날을 누르면 그 주) — 고른 보기는 기억함, '+ 회의 예약'은 예약 양식(회의명을 쓰면 같은 주제의 지난 회의에서 참석자 · 장소 · 이어지는 안건을 채우고, 빠진 칸은 빨갛게, 애매한 이름은 후보에서 고르고, 겹치는 회의를 알림 → desk schedule create, 채팅의 `schedule_form` 카드도 같은 양식), 지표 4개 — '진행 중인 회의'를 누르면 진행 중 · 기록 대기 회의 목록(`#home/live`), '예정된 회의'를 누르면 날짜별 일정(`#home/upcoming`, 회의를 누르면 그 회의 칸), '분공 진행'을 누르면 담당자별 진행(`#home/people`: 완료 · 진행 중 · 미착수 · 기한 지남 막대, 사람별 / 소속별(회사로 묶음, 담당이 8명을 넘으면 처음부터 소속별), 찾기 · 기한 지남만, 사람을 누르면 그 사람의 할 일과 진행 중 · 완료 버튼) · 주제 탭(불 정상 · 주의 · 이상, 누르면 거름) · 회의 표 일시 · 회의 · 주제 · 녹음 · 회의록 · 결정 · 분공 진행 · 메일(진행 중 · 기록 대기 · 예정 · 완료) · 회의 Agent의 활동(날짜별). 회의를 누르면 오른쪽 옆 보기: 개요 · 결정 · 분공 · 메일 탭, 아래에 '회의 Agent에게 묻기'(입력하거나 제안 문장을 누르면 회의 이름 · id를 붙여 새 회의지원 채팅으로 보냄 — 예정된 회의는 '준비 자료 정리' · '밀린 일 독촉'), 진행 중인 회의는 녹음을 놓으면 처리 단계(단계마다 걸린 시간) → 결과 → 확정 · 메일 발송(메일이 날아가는 모습). 10초마다 다시 읽음, Esc로 닫기), 주제(`#topic/주제`: 결정 흐름 · 재검토 제안), 확인할 일(전제가 흔들린 결정 · 확정 전 회의록 · 보내지 못한 메일), 회의록(검색 · 초안/확정), 일정(날짜별), 할 일(내 할 일 / 전체, 기한별), 메일(상태별). 목록을 누르면 옆에 회의 카드가 열리고(`#minutes/MTG-…`, 뒤로 가기 됨) 카드 · 버튼은 채팅과 같으며, Agent가 할 일은 새 회의지원 채팅으로 보냄, 그리고 **회의지원 Agent 채팅의 회의 녹음** — 녹음 시작 효과 · 녹음 중 표시, ✓를 누르면 글로 옮긴 회의록을 녹음 시각과 함께 자동으로 보내 예약된 회의에 초안 저장 (다른 Agent의 음성 입력은 그대로). 수정 후 `sudo docker compose restart open-webui` (파일 하나를 마운트하므로 재시작해야 반영) |

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
cd ~/capstone-agent/agent-backend && git pull /tmp/capstone_demo.bundle integration   # 경영자문 재설계 · KG · 대화 기억이 들어간 브랜치
cd .. && sudo docker compose up -d --build agents-k agents-group
```

LLM 모델 변경: `.env`의 `OLLAMA_MODEL` (기본 `deepseek-v4.1-flash`) 수정 후 `docker compose up -d agents-k agents-group`.

## 로컬 실행 · 스크린샷 (경영자문 · 투자심의 보고서)

서버에 올리기 전에 이 PC에서 Open WebUI까지 띄워 확인합니다. Agent backend는 옆 폴더 `../capstone_demo/backend`를 빌드하므로(`docker-compose.local.yml`),
그 저장소를 `integration`에 두면 소스를 복사하지 않고 최신 backend가 들어갑니다.

```bash
git -C ../capstone_demo checkout integration && git -C ../capstone_demo pull
python3 scripts/gen_env.py      # 최초 1회. OPENWEBUI_PUBLIC_URL=http://localhost:8088 로 바꾸고 OLLAMA_API_KEY 추가
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build postgres keycloak agents-k agents-group gateway open-webui preview mailpit
docker compose stop speech-service   # preview가 함께 띄우지만 모델 파일이 없으면 재시작만 반복 (녹음 STT만 안 됨)
```

- 접속: http://localhost:8088 (Open WebUI), 메일함 http://localhost:8025. 로그인은 데모 계정 `ceo`(경영진, 열람 등급 4) — 보고서를 열려면 경영자문 Agent 권한과
  보고서가 인용한 회의(뉴로엣지 전략회의는 대외비 3)를 볼 등급이 필요합니다. `secretary`는 경영자문 권한이 없어 Super Agent가 경영자문을 건너뛰고 보고서도 생기지 않습니다.
- 지식 그래프는 backend 시작 직후와 이후 `KG_SYNC_INTERVAL`(기본 600초)마다 갱신됩니다. 새 기사를 바로 반영하려면 `.env`에 `KG_SYNC_INTERVAL=60`.
- 대화 기억의 의미 검색은 `MEMORY_EMBED_API_KEY`(OpenAI) 또는 `MEMORY_EMBED_PROVIDER=ollama` + `MEMORY_EMBED_URL`이 있을 때만이고, 없으면 낱말 검색입니다.
- `infra/open-webui/loader.js`를 고친 뒤에는 `docker compose restart open-webui`.

**시연 장면 (Super Agent에게):**

1. "K전자가 검토 중인 뉴로엣지 인수 타당성을 종합 평가해 줘. 경영진이 볼 투자심의 보고서도 함께 줘." → 생각 블록에 그룹 → K전자 A2A, K전자 경영자문의
   지식 그래프 조회 · 미팅/뉴스 조회 · `run_mna_review` · 판단 기록이 보이고, 답변(핵심 결론 먼저) 끝에 **보고서 카드**(권고 배지 · 문서번호 · 보고서 열기 · PDF 내려받기).
2. "뉴로엣지 쪽에 새 소식이 있다던데, 인수 판단을 다시 봐 줘. 달라진 점이 있으면 보고서로 정리해 줘." → 이전 판단을 조회해 비교한 재평가와 새 보고서 카드
   (보고서에 '이전 판단 대비 변경' 장).

**'뉴스 전' 최초 평가와 '11/17 알파모바일 공급계약 중단' 뒤 재평가를 나눠 찍으려면** (뉴스 seed에는 11/17 기사가 이미 들어 있으므로, **로컬에서만**):

1. 저장소를 비운다 — schema는 init이 role 소유로 만든 것이라 superuser로 지우고 같은 소유로 다시 만든다 (회의 · 뉴스 · 지식 그래프 · 대화 기억 · 판단 이력이 지워지고 seed로 다시 채워짐):
   ```bash
   docker compose exec postgres psql -U postgres -d agents -c "
     DROP SCHEMA kelec CASCADE; CREATE SCHEMA kelec AUTHORIZATION agents_k;
     DROP SCHEMA kelec_news CASCADE; CREATE SCHEMA kelec_news AUTHORIZATION agents_k;
     DROP SCHEMA grp CASCADE; CREATE SCHEMA grp AUTHORIZATION agents_group;
     DROP SCHEMA grp_news CASCADE; CREATE SCHEMA grp_news AUTHORIZATION agents_group;"
   ```
2. 11/17 기사를 뺀 뉴스 seed를 agents-k에 마운트하는 override(이 저장소 밖에 두는 파일)로 agents-k · agents-group을 다시 띄운다:
   ```yaml
   services:
     agents-k:
       volumes:
         - /path/to/news_before_2026-11-17.json:/srv/app/systems/k_electronics/data/news.json:ro
   ```
   `docker compose -f docker-compose.yml -f docker-compose.local.yml -f <override> up -d agents-k agents-group` → 1번 장면을 찍는다.
3. override 없이 `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d agents-k`(seed가 11/17 기사를 더함) → 지식 그래프가 갱신되면(`KG_SYNC_INTERVAL`) 2번 장면을 찍는다.

모델이 가끔 빈 응답을 내며 실패하면 같은 요청을 다시 보내고 성공한 화면을 씁니다 (한 번에 30초~2분). 모델은 `.env`의 `OLLAMA_MODEL`.

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
- Agent backend는 `PRINCIPAL_SIGNING_KEY`로 서명된 요청자만 믿습니다. 키는 gateway · agents-k · agents-group만 가집니다.
- 회의지원 Agent는 메일을 승인 없이 보냅니다. 자가 회원가입이 켜져 있으므로 받는 주소를 이름으로 찾을 때는 관리자가 그룹을 배정한 Keycloak 계정만 쓰고 (`gateway/directory.py` `search_people`), 그다음은 Agent backend의 임직원 · 외부 연락처(`staff_directory`)입니다. 자가 가입 계정은 이름이 같아도 회의 메일을 받지 못합니다. 그룹이 있는 사용자가 계정 화면에서 이름을 바꾸는 것도 막으려면 Keycloak 사용자 프로필에서 이름 수정을 관리자 전용으로 두세요.

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
