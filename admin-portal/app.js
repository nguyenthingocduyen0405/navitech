// Users & permissions admin page.
// Talks to the Keycloak Admin REST API with the signed-in admin's own token, so Keycloak enforces
// what they may do and the admin event log records who changed what.
import Keycloak from "https://cdn.jsdelivr.net/npm/keycloak-js@26.2.4/lib/keycloak.js";
import { load as parseYaml } from "https://cdn.jsdelivr.net/npm/js-yaml@5.4.2/+esm";

const LEVELS = ["없음", "공개", "사내", "대외비", "극비"];
const ADMIN_ROLE = "admin";

const $ = (selector) => document.querySelector(selector);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

// ---------- Keycloak ----------

const config = await (await fetch("config.json", { cache: "no-store" })).json();
const kc = new Keycloak({ url: config.keycloakUrl, realm: config.realm, clientId: config.clientId });
await kc.init({ onLoad: "login-required", pkceMethod: "S256", checkLoginIframe: false });

$("#me-name").textContent = kc.tokenParsed.name || kc.tokenParsed.preferred_username;
$("#logout").addEventListener("click", () => kc.logout({ redirectUri: `${location.origin}/` }));

class ApiError extends Error {
  constructor(status, body) {
    super(`${status} ${body}`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = "GET", body } = {}) {
  await kc.updateToken(30);
  const resp = await fetch(`${config.keycloakUrl}/admin/realms/${config.realm}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${kc.token}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) throw new ApiError(resp.status, await resp.text());
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

// ---------- data ----------

const state = { policy: null, groups: {}, adminRole: null, users: [] };

async function load() {
  const [policyText, groups, myRoles] = await Promise.all([
    fetch("permissions.yaml", { cache: "no-store" }).then((r) => r.text()),
    api("/groups?max=200"),
    api(`/users/${kc.subject}/role-mappings/realm/composite`),
  ]);
  state.policy = parseYaml(policyText);
  state.groups = Object.fromEntries(groups.map((g) => [g.name, g]));
  state.adminRole = myRoles.find((r) => r.name === ADMIN_ROLE);

  const users = (await api("/users?max=1000&briefRepresentation=false")).filter(
    (u) => !u.username.startsWith("service-account-"),
  );
  const [members, roleMappings] = await Promise.all([
    Promise.all(groups.map((g) => api(`/groups/${g.id}/members?max=1000&briefRepresentation=true`))),
    Promise.all(users.map((u) => api(`/users/${u.id}/role-mappings/realm`))),
  ]);
  const groupsByUser = {};
  groups.forEach((g, i) => members[i].forEach((m) => (groupsByUser[m.id] ??= []).push(g.name)));
  state.users = users
    .map((u, i) => ({
      ...u,
      groupNames: (groupsByUser[u.id] || []).sort(),
      isAdmin: roleMappings[i].some((r) => r.name === ADMIN_ROLE),
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

async function refresh() {
  await load();
  renderStats();
  renderUsers();
  renderPolicy();
}

// ---------- helpers ----------

const fullName = (u) => [u.lastName, u.firstName].filter(Boolean).join(" ") || u.username;
const groupLabel = (name) => (state.policy.groups[name]?.description || name).split(/[(—]/)[0].trim();
const agentLabel = (id) => (state.policy.agents[id]?.name || id).replace(/ Agent$/, "");
const clearanceOf = (names) => Math.max(0, ...names.map((g) => state.policy.groups[g]?.clearance ?? 0));
const levelBadge = (level) => el("span", { class: `level level-${level}` }, LEVELS[level]);
// Groups take the colour of their clearance level (경영진 = 극비 rose, 개발팀 = 공개 green, ...).
const groupLevel = (name) => state.policy.groups[name]?.clearance ?? 0;
const groupChip = (name) => el("span", { class: `chip level-${groupLevel(name)}` }, groupLabel(name));
const initials = (u) => (u.lastName || u.firstName || u.username).slice(0, 1).toUpperCase();

function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = isError ? "show error" : "show";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (node.className = ""), isError ? 6000 : 3000);
}

function errorMessage(error) {
  if (error.status === 403) return "이 작업을 할 권한이 없습니다.";
  if (error.status === 409) return "이미 사용 중인 아이디 또는 이메일입니다.";
  try {
    const body = JSON.parse(error.body);
    return body.errorMessage || body.error || error.message;
  } catch {
    return error.message;
  }
}

async function run(task) {
  try {
    await task();
  } catch (error) {
    console.error(error);
    toast(errorMessage(error), true);
  }
}

function generatePassword(length = 16) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint32Array(length)), (n) => alphabet[n % alphabet.length]).join("");
}

function confirmTopSecret(addedGroups) {
  const topSecret = addedGroups.filter((g) => state.policy.groups[g]?.clearance === 4);
  return !topSecret.length || confirm(`'${topSecret.map(groupLabel).join(", ")}' 그룹은 극비 자료를 열람할 수 있습니다. 부여할까요?`);
}

// ---------- users table ----------

function renderStats() {
  const users = state.users;
  const stat = (label, value, note, accent) =>
    el(
      "div",
      { class: "stat", style: accent ? `--accent: ${accent}` : null },
      el("div", { class: "stat-label" }, label),
      el("div", { class: "stat-value" }, String(value)),
      el("div", { class: "stat-note" }, note),
    );
  $("#stats").replaceChildren(
    stat("전체 사용자", users.length, `활성 ${users.filter((u) => u.enabled).length}명`),
    stat("시스템 관리자", users.filter((u) => u.isAdmin).length, "사용자 · 권한 관리", "linear-gradient(135deg, #8b5cf6, #6d28d9)"),
    stat("극비 열람 가능", users.filter((u) => clearanceOf(u.groupNames) === 4).length, "경영진 그룹", "var(--l4-solid)"),
    stat("그룹 미배정", users.filter((u) => !u.groupNames.length).length, "Agent 사용 불가", "var(--l3-solid)"),
  );
}

function renderUsers() {
  const query = $("#search").value.trim().toLowerCase();
  const rows = state.users
    .filter((u) => !query || [u.username, u.email, u.firstName, u.lastName].join(" ").toLowerCase().includes(query))
    .map((u) =>
      el(
        "tr",
        {},
        el(
          "td",
          {},
          el(
            "div",
            { class: "person" },
            el("span", { class: `avatar level-${clearanceOf(u.groupNames)}${u.isAdmin ? " admin" : ""}` }, initials(u)),
            el("div", {}, el("div", { class: "name" }, fullName(u)), el("div", { class: "sub" }, u.username)),
          ),
        ),
        el("td", {}, u.email || "—"),
        el(
          "td",
          {},
          el(
            "div",
            { class: "chips" },
            u.isAdmin ? el("span", { class: "chip admin" }, "시스템 관리자") : null,
            u.groupNames.length ? u.groupNames.map(groupChip) : el("span", { class: "chip empty" }, "그룹 없음"),
          ),
        ),
        el("td", {}, levelBadge(clearanceOf(u.groupNames))),
        el("td", {}, el("span", { class: u.enabled ? "status on" : "status off" }, u.enabled ? "활성" : "비활성")),
        el("td", { class: "right" }, el("button", { class: "btn", type: "button", onclick: () => openEdit(u) }, "권한 변경")),
      ),
    );
  $("#users tbody").replaceChildren(
    ...(rows.length ? rows : [el("tr", {}, el("td", { colspan: 6, class: "empty-row" }, "검색 결과가 없습니다."))]),
  );
}

function renderPolicy() {
  const agents = Object.keys(state.policy.agents);
  $("#policy").replaceChildren(
    el(
      "thead",
      {},
      el("tr", {}, el("th", {}, "그룹"), el("th", {}, "열람 등급"), agents.map((id) => el("th", { class: "center" }, agentLabel(id)))),
    ),
    el(
      "tbody",
      {},
      Object.entries(state.policy.groups).map(([name, g]) =>
        el(
          "tr",
          {},
          el(
            "td",
            {},
            el(
              "div",
              { class: "person" },
              el("span", { class: `dot level-${g.clearance}` }),
              el("div", {}, el("div", { class: "name" }, groupLabel(name)), el("div", { class: "sub" }, name)),
            ),
          ),
          el("td", {}, levelBadge(g.clearance)),
          agents.map((id) =>
            el("td", { class: "center" }, g.agents.includes(id) ? el("span", { class: "check" }, "✓") : el("span", { class: "dash" }, "—")),
          ),
        ),
      ),
      el(
        "tr",
        {},
        el(
          "td",
          {},
          el(
            "div",
            { class: "person" },
            el("span", { class: "dot", style: "background: var(--gradient)" }),
            el("div", {}, el("div", { class: "name" }, "시스템 관리자"), el("div", { class: "sub" }, "role: admin")),
          ),
        ),
        el("td", { colspan: agents.length + 1, class: "muted" }, "사용자 · 권한 관리만 가능합니다. Agent와 자료 열람 권한은 그룹으로 부여합니다."),
      ),
    ),
  );
}

// ---------- dialogs ----------

function groupOptions(selected) {
  return Object.entries(state.policy.groups).map(([name, g]) => {
    const missing = !state.groups[name];
    return el(
      "label",
      { class: "option" },
      el("input", { type: "checkbox", name: "group", value: name, checked: selected.includes(name), disabled: missing }),
      el(
        "div",
        {},
        el("div", { class: "option-title" }, el("span", { class: `dot level-${g.clearance}` }), g.description),
        el(
          "div",
          { class: "option-desc" },
          missing ? "Keycloak에 이 그룹이 없습니다 — 먼저 그룹을 만들어 주세요." : `열람 등급 ${LEVELS[g.clearance]} · ${g.agents.map(agentLabel).join(", ")}`,
        ),
      ),
    );
  });
}

function toggle(name, label, { checked, disabled }) {
  return el("label", { class: "toggle" }, el("input", { type: "checkbox", name, checked, disabled }), el("span", {}, label));
}

function showDialog(form, onSave) {
  const dialog = $("#dialog");
  dialog.replaceChildren(form);
  dialog.returnValue = "";
  dialog.onclose = () => dialog.returnValue === "save" && run(() => onSave(new FormData(form)));
  dialog.showModal();
}

const dialogButtons = (saveLabel) =>
  el(
    "menu",
    {},
    el("button", { class: "btn ghost", value: "cancel", formnovalidate: true }, "취소"),
    el("button", { class: "btn primary", value: "save" }, saveLabel),
  );

function openEdit(user) {
  const isSelf = user.id === kc.subject;
  const form = el(
    "form",
    { method: "dialog" },
    el("h3", {}, "권한 변경"),
    el("p", { class: "muted" }, `${fullName(user)} · ${user.email || user.username}`),
    el("fieldset", {}, el("legend", {}, "권한 그룹"), groupOptions(user.groupNames)),
    el(
      "fieldset",
      {},
      el("legend", {}, "계정"),
      toggle("admin", "시스템 관리자 — 사용자 · 권한 관리 (자료 열람 권한은 그룹으로만 부여)", { checked: user.isAdmin, disabled: isSelf }),
      toggle("enabled", "계정 활성화 — 끄면 즉시 로그아웃되고 로그인할 수 없습니다", { checked: user.enabled, disabled: isSelf }),
    ),
    isSelf ? el("p", { class: "note" }, "본인의 관리자 권한과 계정 상태는 여기서 바꿀 수 없습니다.") : null,
    el("p", { class: "note" }, "Agent 사용 권한은 1분 이내 적용됩니다. Open WebUI의 Agent 목록은 사용자가 다시 로그인하면 갱신됩니다."),
    dialogButtons("저장"),
  );
  showDialog(form, (data) => saveEdit(user, data, isSelf));
}

async function saveEdit(user, data, isSelf) {
  const wanted = new Set(data.getAll("group"));
  const added = [...wanted].filter((g) => !user.groupNames.includes(g));
  const removed = user.groupNames.filter((g) => state.policy.groups[g] && !wanted.has(g));
  const ops = [
    ...added.map((g) => () => api(`/users/${user.id}/groups/${state.groups[g].id}`, { method: "PUT" })),
    ...removed.map((g) => () => api(`/users/${user.id}/groups/${state.groups[g].id}`, { method: "DELETE" })),
  ];
  if (!isSelf) {
    const admin = data.get("admin") === "on";
    if (admin !== user.isAdmin) {
      ops.push(() => api(`/users/${user.id}/role-mappings/realm`, { method: admin ? "POST" : "DELETE", body: [state.adminRole] }));
    }
    const enabled = data.get("enabled") === "on";
    if (enabled !== user.enabled) {
      ops.push(async () => {
        const current = await api(`/users/${user.id}`);
        await api(`/users/${user.id}`, { method: "PUT", body: { ...current, enabled } });
        if (!enabled) await api(`/users/${user.id}/logout`, { method: "POST" });
      });
    }
  }
  if (!ops.length) return toast("변경 사항이 없습니다.");
  if (!confirmTopSecret(added)) return;
  for (const op of ops) await op();
  await refresh();
  toast(`${fullName(user)} 님의 권한을 변경했습니다.`);
}

function openAdd() {
  const field = (name, label, attrs = {}) =>
    el("label", { class: "field" }, el("span", {}, label), el("input", { name, required: true, ...attrs }));
  const form = el(
    "form",
    { method: "dialog" },
    el("h3", {}, "사용자 추가"),
    el(
      "div",
      { class: "grid" },
      field("username", "아이디", { pattern: "[a-z0-9._\\-]{3,}", title: "영문 소문자 · 숫자 · . _ - 3자 이상", autocomplete: "off" }),
      field("email", "이메일", { type: "email", autocomplete: "off" }),
      field("lastName", "성"),
      field("firstName", "이름"),
    ),
    el("fieldset", {}, el("legend", {}, "권한 그룹"), groupOptions([])),
    el("fieldset", {}, el("legend", {}, "계정"), toggle("admin", "시스템 관리자 — 사용자 · 권한 관리", { checked: false })),
    el("p", { class: "note" }, "임시 비밀번호가 생성되며, 사용자는 첫 로그인 때 비밀번호를 바꿔야 합니다."),
    dialogButtons("추가"),
  );
  showDialog(form, saveAdd);
}

async function saveAdd(data) {
  const groups = data.getAll("group");
  if (!confirmTopSecret(groups)) return;
  const username = data.get("username").trim().toLowerCase();
  const password = generatePassword();
  await api("/users", {
    method: "POST",
    body: {
      username,
      email: data.get("email").trim(),
      firstName: data.get("firstName").trim(),
      lastName: data.get("lastName").trim(),
      enabled: true,
      emailVerified: true,
      groups: groups.map((g) => state.groups[g].path),
      credentials: [{ type: "password", value: password, temporary: true }],
    },
  });
  if (data.get("admin") === "on") {
    const [created] = await api(`/users?username=${encodeURIComponent(username)}&exact=true`);
    await api(`/users/${created.id}/role-mappings/realm`, { method: "POST", body: [state.adminRole] });
  }
  await refresh();
  showPassword(username, password);
}

function showPassword(username, password) {
  const copy = el("button", { class: "btn", type: "button" }, "복사");
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(password);
    copy.textContent = "복사됨";
  });
  const dialog = $("#dialog");
  dialog.replaceChildren(
    el(
      "form",
      { method: "dialog" },
      el("h3", {}, "사용자를 추가했습니다"),
      el("p", { class: "muted" }, `아이디 ${username}의 임시 비밀번호입니다. 이 창을 닫으면 다시 볼 수 없습니다.`),
      el("div", { class: "secret" }, el("code", {}, password), copy),
      el("menu", {}, el("button", { class: "btn primary", value: "close" }, "확인")),
    ),
  );
  dialog.returnValue = "";
  dialog.onclose = null;
  dialog.showModal();
}

// ---------- start ----------

if (!kc.hasRealmRole(ADMIN_ROLE)) {
  $("#state").textContent = "이 페이지는 시스템 관리자만 사용할 수 있습니다.";
} else {
  await run(async () => {
    await refresh();
    $("#state").hidden = true;
    $("#users-section").hidden = false;
    $("#policy-section").hidden = false;
  });
  $("#search").addEventListener("input", renderUsers);
  $("#add-user").addEventListener("click", openAdd);
}
