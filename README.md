# navitech — C-Level AI Agent (SK × JBNU Capstone)

Bộ khung chạy end-to-end: **đăng nhập SSO (Keycloak) → Open WebUI → Gateway (phân quyền, audit) → 4 agent**.
Các agent hiện là bản mock; thay bằng logic thật mà không phải sửa phần đăng nhập/phân quyền.

```
Open WebUI ── chọn 1 trong 4: Super Agent | 경영자문 | 뉴스 Briefing | 회의지원
     │  OpenAI API  +  X-OpenWebUI-User-Jwt (JWT ký HS256)
     ▼
Gateway (FastAPI)  gateway/
  1. kiểm tra API key  →  2. xác minh JWT  →  3. tra group trong Keycloak
  4. UserContext + kiểm tra quyền (config/permissions.yaml)  →  5. ghi audit_log
     │
     ├── super-agent ──► Super Agent ──┐ (chỉ gọi agent mà user được phép dùng)
     ├── advisory-agent ───────────────┼──► 경영자문 Agent
     ├── news-agent ───────────────────┼──► 뉴스 Briefing Agent
     └── meeting-agent ────────────────┴──► 회의지원 Agent
                                              │  shared/access.py: lọc tài liệu theo clearance
                                              ▼
                              Postgres (pgvector) · Keycloak · LLM API
```

## Thư mục

| Đường dẫn | Nội dung | Phụ trách |
|---|---|---|
| `config/permissions.yaml` | **Nguồn duy nhất** cho phân quyền: group → clearance, agent được dùng | Auth |
| `gateway/` | API tương thích OpenAI, xác thực, phân quyền, audit log, script đồng bộ Open WebUI | Auth |
| `admin-portal/` | Trang 사용자 · 권한 관리 (HTML/JS tĩnh, gọi Keycloak Admin API) | Auth |
| `infra/keycloak/capstone-realm.json` | Realm, role, group, client, tài khoản demo | Auth |
| `shared/user_context.py` | `UserContext` — truyền vào mọi agent / tool | Chung |
| `shared/access.py` | Quy tắc lọc dữ liệu theo quyền cho RAG / ontology | Chung (Auth + RAG) |
| `agents/base.py` | Interface `Agent.run(messages, ctx, task)` và `AgentEvent` | Agent |
| `agents/mock.py`, `agents/super_agent.py` | Agent giả — thay bằng agent thật | Agent |
| `tests/` | Test bảo mật của gateway | Auth |

## Chạy trên server

```bash
# trên instance
cd ~/capstone-agent
python3 scripts/gen_env.py          # chỉ lần đầu: sinh .env với secret ngẫu nhiên
sudo docker compose up -d --build
sudo docker compose ps              # chờ keycloak "healthy" (~1 phút)
```

Mọi port chỉ mở trên `127.0.0.1` của server. Từ máy cá nhân, mở **SSH tunnel** rồi dùng trình duyệt như chạy local:

```bash
ssh -i <key.pem> -p <SSH_PORT> -N -L 3000:127.0.0.1:3000 -L 3001:127.0.0.1:3001 -L 8080:127.0.0.1:8080 ubuntu@<SERVER_IP>
```

> Địa chỉ server, cổng SSH và file key được chia sẻ riêng trong nhóm — không ghi vào repo (repo public).

- Open WebUI: http://localhost:3000
- **사용자 · 권한 관리: http://localhost:3001** (tài khoản có role `admin`)
- Keycloak admin console: http://localhost:8080/admin (user `kcadmin`, mật khẩu `KEYCLOAK_ADMIN_PASSWORD` trong `.env`) — chỉ khi cần sửa cấu hình realm

### Tài khoản demo

Mật khẩu chung: `grep DEMO_USER_PASSWORD ~/capstone-agent/.env`

| Đăng nhập | Role | Group | Clearance | Agent được dùng |
|---|---|---|---|---|
| `ceo` | user | executive | 4 (극비) | cả 4 |
| `secretary` | user | secretary | 3 (대외비) | Super, 뉴스, 회의지원 |
| `staff` | user | staff | 2 (사내) | cả 4 |
| `sysadmin` | **admin** | developer | 1 (공개) | cả 4 + quản lý user |

### Phân quyền: hai trục độc lập

- **Role (Keycloak)** — ai quản lý hệ thống. `user`: đăng nhập. `admin`: quản lý user/group. **Role admin một mình không cho dùng agent hay xem dữ liệu.**
- **Group (`config/permissions.yaml`)** — dùng agent nào, xem dữ liệu đến mức nào.

Mỗi người = 1 role + 1 hoặc nhiều group (nhiều group → lấy clearance cao nhất, gộp agent).
Thành viên nhóm phát triển → group `developer`: thử được mọi agent nhưng chỉ thấy dữ liệu 공개.
Người không có group nào nhận thông báo "소속 그룹이 없어 Agent를 사용할 수 없습니다…".

### Lần đầu: đồng bộ quyền sang Open WebUI

Open WebUI chỉ hiện model cho user thường khi model đó đã được cấp quyền. Sau lần khởi động đầu tiên:

1. Đăng nhập Open WebUI bằng `sysadmin` **trước tiên** (người đăng nhập đầu tiên luôn thành admin của Open WebUI) → **Settings → Account → API Keys** → tạo key.
2. Chạy:
   ```bash
   sudo docker compose exec -e OPENWEBUI_ADMIN_API_KEY=sk-... gateway python -m gateway.sync_openwebui
   ```
3. Các user khác **đăng nhập lại** để Open WebUI gán group từ Keycloak.

## Giao diện

Trang đăng nhập (Keycloak), trang 사용자 · 권한 관리 và Open WebUI dùng chung một bộ màu thương hiệu (gradient indigo → violet → fuchsia), font Pretendard, tự theo chế độ sáng/tối của hệ thống.

**Đổi màu thương hiệu:** sửa biến gradient/brand ở đầu 3 file — `capstone.css` (`--cap-gradient`, `--cap-brand`…), `admin-portal/style.css` (`--gradient`, `--brand`…), `infra/open-webui/custom.css` (`--cap-gradient`…). Màu theo mức dữ liệu (공개 xanh lá · 사내 xanh dương · 대외비 cam · 극비 đỏ) dùng cho cả badge và group.

| File | Tác dụng |
|---|---|
| `infra/keycloak/themes/capstone/login/resources/css/capstone.css` | Theme đăng nhập `capstone` (kế thừa `keycloak.v2`). Sửa xong chỉ cần tải lại trang (dev mode không cache theme) |
| `infra/open-webui/custom.css` | Font + cỡ chữ của Open WebUI (mặc định to hơn 10%). Sửa xong: `sudo docker compose restart open-webui` |

- `OAUTH_AUTO_REDIRECT=true`: bỏ màn hình đăng nhập riêng của Open WebUI, người dùng vào thẳng trang đăng nhập chung.
- Mỗi người vẫn tự chỉnh cỡ chữ được ở **설정 → 인터페이스 → UI Scale** (nhân thêm trên mức mặc định).
- Tên và logo "Open WebUI" được giữ nguyên theo giấy phép của Open WebUI (chỉ được bỏ khi ≤ 50 người dùng/30 ngày hoặc có license enterprise).
- Font tải từ CDN jsDelivr; nếu mạng nội bộ chặn CDN, giao diện tự dùng font hệ thống.

## Thay đổi phân quyền

1. Sửa `config/permissions.yaml` (group, clearance, agent).
2. Group mới → tạo group cùng tên trong Keycloak và thêm user vào.
3. `sudo docker compose restart gateway` rồi chạy lại bước sync ở trên.

## Quản lý user

**Trang 사용자 · 권한 관리: http://localhost:3001** (`admin-portal/`) — đăng nhập bằng tài khoản có role `admin` (ví dụ `sysadmin`).

| Việc | Trên trang |
|---|---|
| Xem user, quyền, mức dữ liệu | Bảng **사용자** |
| Đổi quyền | **권한 변경** → chọn group (mô tả agent + mức dữ liệu của từng group), bật/tắt *시스템 관리자*, *계정 활성화* (tắt = đăng xuất ngay) |
| Thêm user | **+ 사용자 추가** → tạo mật khẩu tạm (hiện 1 lần), user phải đổi ở lần đăng nhập đầu |
| Xem hệ thống phân quyền | Bảng **권한 체계** (đọc từ `config/permissions.yaml`) |

- Trang gọi thẳng Keycloak Admin API bằng token của chính admin đang đăng nhập → Keycloak tự kiểm quyền, và lịch sử ghi đúng người sửa. User không có role `admin` chỉ thấy thông báo "시스템 관리자만 사용할 수 있습니다".
- Không tự đổi quyền admin / khoá chính mình được (tránh tự khoá).
- Cấp group có mức 극비 phải xác nhận thêm một lần.
- Gateway áp dụng quyền mới ngay (tối đa 60 giây); danh sách agent trong Open WebUI cập nhật khi user đăng nhập lại.
- Xoá hẳn user / reset mật khẩu: dùng Keycloak console http://localhost:8080/admin/capstone/console/ (đăng nhập bằng `sysadmin`).

- Mọi thay đổi user/group được ghi lại (**Events → Admin events**), đăng nhập ghi ở **Events → User events** (lưu 90 ngày).
- **Không** đổi role/group trong trang Admin của Open WebUI — mỗi lần đăng nhập, Open WebUI ghi đè lại theo Keycloak.
- `kcadmin` (realm `master`) là super admin của cả Keycloak — chỉ dùng khi cần sửa cấu hình realm.

> `capstone-realm.json` chỉ được import khi realm **chưa tồn tại**. Sửa file này sau lần chạy đầu sẽ không có tác dụng — sửa trong admin console, hoặc xoá volume để import lại.

## Hợp đồng cho các thành viên

**Agent** — cài đặt interface trong `agents/base.py`, đăng ký trong `agents/registry.py`:
- Gọi `require_access(ctx, self.id)` đầu tiên trong `run()`.
- Truyền `ctx` cho mọi tool. Quyền kiểm tra **bằng code**, không bằng prompt.
- Trả về `AgentEvent.text` (câu trả lời), `.status` (tiến trình — hiện trong khối "thinking"), `.citation` (id tài liệu đã dùng — vào audit log).
- Agent con phải tự đứng được (được gọi trực tiếp, không qua Super Agent).

**RAG / ontology** — mỗi chunk / node có metadata theo `shared/access.py`
(`classification` 1–4, `allowed_groups`, `meeting_id`, `source`) và áp `retrieval_filter(ctx)` **bên trong** câu truy vấn, trước similarity search.

## Ghi chú bảo mật

- Gateway chỉ tin JWT ký bởi Open WebUI (`X-OpenWebUI-User-Jwt`), không tin header thường `X-OpenWebUI-User-*`.
- Open WebUI chỉ cho đăng nhập qua SSO. **Không bật** `ENABLE_LOGIN_FORM` / `ENABLE_SIGNUP`: tài khoản local trùng email lãnh đạo sẽ được gateway coi là lãnh đạo.
- Audit log ghi trước khi agent chạy; ghi thất bại → từ chối yêu cầu.
- Admin Open WebUI không đọc được chat của người khác (`ENABLE_ADMIN_CHAT_ACCESS=false`).
- `start-dev` + HTTP chỉ dùng cho phát triển qua SSH tunnel. Mở ra Internet cần HTTPS + `kc.sh start`.

## Test

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt   # Windows
.venv/Scripts/python -m pytest -q
```

## Việc tiếp theo (Auth)

- [ ] Mở port public + tên miền + HTTPS (reverse proxy) để nhóm/mentor truy cập không cần tunnel
- [ ] Đăng nhập dashboard qua Keycloak; gateway xác minh access token Keycloak (JWKS)
- [ ] `meeting_ids` trong `UserContext` từ dữ liệu thành viên cuộc họp
- [ ] Liên kết tài khoản Telegram
- [ ] Test prompt injection / vượt quyền với agent thật
