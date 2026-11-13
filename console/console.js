// Cuff AI Console: the admin side of the Cuff AI Control Plane.
// Every permission is checked again on the server; the console only hides what you can't do.
"use strict";

const PROD_AUTH = "https://unehdhdrbhkkvoripxat.supabase.co/functions/v1/cuff-api";
const PROD_CP = "https://unehdhdrbhkkvoripxat.supabase.co/functions/v1/cuff-control";
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const qs = new URLSearchParams(location.search);
// local testing only: point the console at a development server, with a session token made by the tests
const API_CP = (LOCAL && qs.get("api")) || PROD_CP;
const API_AUTH = PROD_AUTH;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* private mode */ } },
};

let TOKEN = (LOCAL && qs.get("token")) || store.get("cuffconsole.token");
let ME = null, ORG = null, PEOPLE = [], STRUCT = { departments: [], teams: [] }, WS = [];

const ROLES = { super_admin: "Super admin", admin: "Administrator", security_manager: "Security manager", team_manager: "Team manager", employee: "Employee" };
const PERMS = {
  "org.settings": ["super_admin"], "members.manage": ["super_admin", "admin"], "teams.manage": ["super_admin", "admin"],
  "workstations.manage": ["super_admin", "admin"], "agents.manage": ["super_admin", "admin"], "agents.team": ["super_admin", "admin", "team_manager"],
  "policy.manage": ["super_admin", "security_manager"], "audit.read": ["super_admin", "admin", "security_manager"],
};
const can = (perm) => !!ORG && (PERMS[perm] || []).includes(ORG.me.role);
const mayAssign = (role) => ORG.me.role === "super_admin" || (ORG.me.role === "admin" && ["team_manager", "employee"].includes(role));
const LEVELS = ["0 · No access (talk only)", "1 · Read scoped folders", "2 · Staged writes (review first)", "3 · Sandboxed commands",
  "4 · Allowlisted web", "5 · Real folders (auto-snapshot)", "6 · Full machine"];

// ---- talking to the servers ------------------------------------------------------------------------------------------
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(TOKEN ? { authorization: "Bearer " + TOKEN } : {}) },
    body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `The server had a problem (${r.status}).`); e.status = r.status; throw e; }
  return j;
}

// a control-plane call. A change that needs a fresh second factor asks for it, then retries once.
async function cp(op, args = {}, retried = false) {
  try {
    return await post(API_CP, { op, args: ORG && !("org_id" in args) && op !== "me" && !op.startsWith("mfa_") && op !== "invite_accept" ? { org_id: ORG.org_id, ...args } : args });
  } catch (e) {
    if (e.status === 401 && /sign in/i.test(e.message)) { signOut(); throw e; }
    if (e.status === 428 && !retried) { if (await askSecondFactor(e.message)) return cp(op, args, true); }
    throw e;
  }
}

// ---- small UI helpers ------------------------------------------------------------------------------------------------
let toastTimer;
function toast(msg, bad = false) {
  const t = $("toast"); t.textContent = msg; t.className = "toast show" + (bad ? " err" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = "toast" + (bad ? " err" : "")), 3800);
}
const fail = (e) => toast(e.message || String(e), true);

function when(ts) {
  if (!ts) return "—";
  const d = new Date(ts), s = (Date.now() - d) / 1000;
  if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
const stamp = (ts) => ts ? new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }) : "—";
const person = (id) => { const p = PEOPLE.find((x) => x.id === id); return p ? (p.display_name || p.email) : (id ? "Removed member" : "Unassigned"); };
const wsName = (id) => WS.find((w) => w.id === id)?.name || (id ? "Unknown workstation" : "—");
const teamName = (id) => STRUCT.teams.find((t) => t.id === id)?.name || (id ? "Removed team" : "—");
const deptName = (id) => STRUCT.departments.find((d) => d.id === id)?.name || (id ? "Removed department" : "—");
const opts = (list, sel, none) => (none !== undefined ? `<option value="">${esc(none)}</option>` : "") +
  list.map(([v, l]) => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(l)}</option>`).join("");
const peopleOpts = (sel) => opts(PEOPLE.filter((p) => p.status === "active").map((p) => [p.id, p.display_name || p.email]), sel, "Unassigned");
const teamOpts = (sel, none = "No team") => opts(STRUCT.teams.map((t) => [t.id, t.name]), sel, none);
const deptOpts = (sel) => opts(STRUCT.departments.map((d) => [d.id, d.name]), sel, "No department");

const AGENT_STATUS = { running: "ok", active: "ok", idle: "plain", awaiting_approval: "warn", suspended: "warn", disabled: "bad", error: "bad" };
const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;
const agentPill = (s) => pill(AGENT_STATUS[s] || "", s.replace("_", " "));

function modal(title, html, onSubmit) {
  $("mtitle").textContent = title; $("mbody").innerHTML = html; $("modal").hidden = false;
  const f = $("mbody").querySelector("form"), first = $("mbody").querySelector("input,select,textarea,button");
  first?.focus();
  $("mbody").querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeModal));
  if (f && onSubmit) f.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = f.querySelector("button[type=submit],button:not([type])"); if (btn) btn.disabled = true;
    try { await onSubmit(new FormData(f), f); } catch (e) { const er = f.querySelector(".err"); if (er) er.textContent = e.message; else fail(e); }
    finally { if (btn) btn.disabled = false; }
  };
}
function closeModal() { $("modal").hidden = true; $("mbody").innerHTML = ""; if (modalResolve) { modalResolve(false); modalResolve = null; } }
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!$("modal").hidden) closeModal(); else closeDrawer(); } });

function drawer(html) {
  closeDrawer();
  const d = document.createElement("aside"); d.className = "drawer"; d.id = "drawer"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "false");
  d.innerHTML = `<div class="row" style="justify-content:flex-end"><button class="btn ghost sm" data-x>Close</button></div>` + html;
  document.body.appendChild(d); d.querySelector("[data-x]").onclick = closeDrawer; d.querySelector("h2")?.setAttribute("tabindex", "-1");
  d.querySelector("h2")?.focus();
  return d;
}
function closeDrawer() { $("drawer")?.remove(); }

async function confirmBox(title, text, label = "Confirm", danger = true) {
  return new Promise((res) => {
    modalResolve = res;
    modal(title, `<form class="form"><p class="muted" style="margin:0">${text}</p><div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn ${danger ? "danger" : "primary"}">${esc(label)}</button></div></form>`, async () => { modalResolve = null; closeModal(); res(true); });
  });
}
let modalResolve = null;

// ---- the second factor -----------------------------------------------------------------------------------------------
async function askSecondFactor(msg) {
  if (!ME?.mfa?.enabled) {
    modal("Two-step sign-in needed", `<div class="form"><p class="muted" style="margin:0">${esc(msg)}</p>
      <p class="muted" style="margin:0">Your organisation requires two-step sign-in for changes. Turn it on in Settings, then try again.</p>
      <div class="actions"><button class="btn ghost" data-close>Not now</button><button class="btn primary" id="gomfa">Open Settings</button></div></div>`);
    $("gomfa").onclick = () => { closeModal(); go("settings"); };
    return false;
  }
  return new Promise((res) => {
    modalResolve = res;
    modal("Confirm it's you", `<form class="form"><p class="muted" style="margin:0">Enter the 6-digit code from your authenticator app. You won't be asked again on this sign-in for 12 hours.</p>
      <label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label><p class="err"></p>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Confirm</button></div></form>`,
    async (fd) => { await post(API_CP, { op: "mfa_verify", args: { code: fd.get("code") } }); ME.mfa.verified = true; modalResolve = null; closeModal(); res(true); });
  });
}

// ---- sign in -----------------------------------------------------------------------------------------------------------
function show(id) { for (const s of ["boot", "signin", "orgs", "app"]) $(s).hidden = s !== id; }

$("emailf").onsubmit = async (e) => {
  e.preventDefault(); $("autherr").textContent = "";
  const b = e.submitter; b.disabled = true;
  try { await post(API_AUTH, { op: "send_code", email: $("email").value.trim() }); $("emailf").hidden = true; $("codef").hidden = false; $("code").focus(); }
  catch (er) { $("autherr").textContent = er.message; } finally { b.disabled = false; }
};
$("codef").onsubmit = async (e) => {
  e.preventDefault(); $("autherr").textContent = "";
  const b = e.submitter; b.disabled = true;
  try {
    const r = await post(API_AUTH, { op: "verify_code", email: $("email").value.trim(), code: $("code").value.trim() });
    TOKEN = r.token; store.set("cuffconsole.token", TOKEN); await start();
  } catch (er) { $("autherr").textContent = er.message; } finally { b.disabled = false; }
};
$("back").onclick = () => { $("codef").hidden = true; $("emailf").hidden = false; $("email").focus(); };

function signOut() {
  TOKEN = null; ME = null; ORG = null; store.set("cuffconsole.token", null); store.set("cuffconsole.org", null);
  closeDrawer(); $("codef").hidden = true; $("emailf").hidden = false; show("signin");
}
$("signout1").onclick = $("signout2").onclick = signOut;

// ---- organisations ---------------------------------------------------------------------------------------------------
async function start() {
  if (!TOKEN) return show("signin");
  try { ME = await cp("me"); } catch (e) { if (e.status === 401) return; show("signin"); $("autherr").textContent = e.message; return; }
  const inv = (location.hash.match(/invite=([0-9a-f]{64})/) || [])[1];
  if (inv) {
    history.replaceState(null, "", location.pathname + location.search);
    try { const r = await cp("invite_accept", { token: inv }); ME = await cp("me"); store.set("cuffconsole.org", r.org_id); toast("You've joined the organisation."); }
    catch (e) { fail(e); }
  }
  const last = store.get("cuffconsole.org");
  if (last && ME.orgs.some((o) => o.org_id === last)) return openOrg(last);
  if (ME.orgs.length === 1 && !inv) return openOrg(ME.orgs[0].org_id);
  pickOrg();
}

function pickOrg() {
  closeDrawer(); show("orgs");
  $("orglist").innerHTML = ME.orgs.length ? ME.orgs.map((o) => `<li><button data-org="${esc(o.org_id)}"><span><b>${esc(o.name)}</b>
    <span class="sub">${esc(ROLES[o.role] || o.role)}</span></span><span class="muted">Open →</span></button></li>`).join("")
    : `<li class="muted">You aren't in an organisation yet. Create one below, or open the invitation link your administrator sent you.</li>`;
  $("orglist").querySelectorAll("[data-org]").forEach((b) => (b.onclick = () => openOrg(b.dataset.org)));
  $("invitebox").innerHTML = (ME.invites || []).length ? `<div class="notice small" style="margin-top:12px"><b>Pending invitations:</b> ${ME.invites.map((i) =>
    `${esc(i.org_name)} (${esc(ROLES[i.role] || i.role)})`).join(", ")}. Open the link in your invitation email to join.</div>` : "";
}
$("neworg").onsubmit = async (e) => {
  e.preventDefault(); $("orgerr").textContent = "";
  const b = e.submitter; b.disabled = true;
  try { const r = await cp("org_create", { name: $("orgname").value.trim() }); ME = await cp("me"); $("orgname").value = ""; openOrg(r.org_id); }
  catch (er) { $("orgerr").textContent = er.message; } finally { b.disabled = false; }
};
$("orgswitch").onclick = async () => { ORG = null; store.set("cuffconsole.org", null); try { ME = await cp("me"); } catch { /* shown */ } pickOrg(); };

async function openOrg(id) {
  try { ORG = null; ORG = await cp("org_get", { org_id: id }); } catch (e) { fail(e); return pickOrg(); }
  store.set("cuffconsole.org", id);
  $("orgname2").textContent = ORG.name; $("myrole").textContent = ROLES[ORG.me.role]; $("whoami").textContent = ME.email;
  await refreshPeople();
  show("app"); buildNav(); route();
}
async function refreshPeople() {
  const [m, s] = await Promise.all([cp("members_list"), cp("structure")]);
  PEOPLE = m.members; STRUCT = s; return m;
}

// ---- navigation: twelve sections, the ones not built yet say so ---------------------------------------------------------
const SECTIONS = [
  ["overview", "Overview", 1], ["agents", "AI Agents", 1], ["workstations", "Workstations", 1], ["people", "Employees & Teams", 1],
  ["policies", "Permissions & Policies", 1], ["approvals", "Approvals", 2], ["activity", "Activity Monitor", 3],
  ["security", "Security Center", 4], ["models", "Model Management", 4], ["audit", "Audit Logs", 1], ["usage", "Usage & Costs", 5],
  ["settings", "Settings", 1],
];
function buildNav() {
  $("nav").innerHTML = SECTIONS.map(([k, label, phase]) => `<button data-k="${k}">${esc(label)}${phase > 1 ? `<span class="soon" title="Not built yet">Phase ${phase}</span>` : ""}</button>`).join("");
  $("nav").querySelectorAll("button").forEach((b) => (b.onclick = () => go(b.dataset.k)));
}
function go(k) { if (location.hash !== "#/" + k) location.hash = "#/" + k; else route(); }
window.addEventListener("hashchange", () => { if (ORG) route(); });

const PAGES = {};
async function route() {
  closeDrawer();
  const k = (location.hash.match(/^#\/([a-z]+)/) || [])[1] || "overview";
  const sec = SECTIONS.find((s) => s[0] === k) || SECTIONS[0];
  $("nav").querySelectorAll("button").forEach((b) => { if (b.dataset.k === sec[0]) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  document.title = `${sec[1]} · ${ORG.name} · Cuff AI Console`;
  const main = $("main"); main.innerHTML = `<div class="spinner" aria-label="Loading"></div>`;
  try { await (PAGES[sec[0]] || notBuilt(sec))(main); } catch (e) { main.innerHTML = `<div class="notice"><b>Couldn't load this page.</b> ${esc(e.message)}</div>`; }
  main.focus({ preventScroll: true });
}
const head = (title, sub, actions = "") => `<div class="head"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ""}</div><div class="row">${actions}</div></div>`;
const table = (cols, rows, empty) => `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th${c.startsWith("#") ? ' class="num"' : ""}>${esc(c.replace(/^#/, ""))}</th>`).join("")}</tr></thead>
  <tbody>${rows.length ? rows.join("") : `<tr><td colspan="${cols.length}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;

// ---- sections that are not built yet: say what's coming, show nothing invented ------------------------------------------
const LATER = {
  approvals: ["Human approvals arrive with the policy engine.", ["Rules that answer REQUIRE APPROVAL route the request here", "Approve or deny with a reason, with time limits and escalation", "Every decision written to the audit log"]],
  activity: ["Live monitoring arrives in Phase 3.", ["A live stream of what agents do on each workstation, marked verified (reported and signed by the workstation) or estimated", "The kill switch, showing a command issued separately from a command the workstation confirmed it enforced", "Remote policy updates with delivery status per workstation"]],
  security: ["Security intelligence arrives in Phase 4.", ["Alerts for blocked actions, prompt-injection signs, unknown agents and unusual activity", "Findings from Cuff's agent scan on enrolled workstations", "Response actions linked to the kill switch"]],
  models: ["Model management arrives in Phase 4.", ["An inventory of the AI models and providers your agents use", "Allow and block lists of models and providers, by team", "Where model credentials live, without ever showing a secret"]],
  usage: ["Usage and costs arrive in Phase 5.", ["Usage per agent, team and provider", "Costs shown as estimates, clearly labelled, unless a provider bill confirms them", "Budgets and alerts"]],
};
function notBuilt(sec) {
  return async (main) => {
    const [lead, items] = LATER[sec[0]] || ["Not built yet.", []];
    main.innerHTML = head(sec[1], "") + `<div class="notice"><b>Not built yet (Phase ${sec[2]}).</b> ${esc(lead)} Nothing on this page is simulated.
      <ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>` +
      (sec[0] === "activity" && can("audit.read") ? `<p class="muted small" style="margin-top:14px">Until then, workstation check-ins and events are in <a href="#/audit">Audit Logs</a>.</p>` : "");
  };
}

// ---- Overview ----------------------------------------------------------------------------------------------------------
PAGES.overview = async (main) => {
  const o = await cp("overview");
  const tile = (k, v, n) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="n">${n}</div></div>`;
  const na = (k, phase) => `<div class="tile na"><div class="k">${esc(k)}</div><div class="v">Not measured yet</div><div class="n">Arrives in Phase ${phase}</div></div>`;
  main.innerHTML = head("Overview", `${esc(ORG.name)} · you are ${esc(ROLES[ORG.me.role])}`) +
    `<div class="tiles">
      ${tile("AI agents", o.agents.total, `${o.agents.running} running · ${o.agents.idle + o.agents.active} idle or active`)}
      ${tile("Suspended or disabled", o.agents.suspended + o.agents.disabled, "Set by your organisation")}
      ${tile("Workstations connected", `${o.workstations.connected} / ${o.workstations.total}`, `Checked in within ${o.connected_minutes} min`)}
      ${tile("Members", o.members, "Active people in this organisation")}
      ${tile("Policy in force", o.policy_version ? "v" + o.policy_version : "—", "Signed with your organisation key")}
      ${na("Pending approvals", 2)}${na("Security alerts", 4)}${na("Estimated spend", 5)}
    </div>
    <div class="grid cols2">
      <section class="card"><h2>Recent activity</h2>${can("audit.read") ? (o.recent.length ? `<ul class="feed">${o.recent.map((r) =>
        `<li>${pill(r.outcome === "ok" ? "ok" : r.outcome === "denied" ? "warn" : "bad", r.outcome)}<span><b>${esc(r.action)}</b><span class="sub">${esc(r.actor_label || "")}</span></span>
        <time datetime="${esc(r.ts)}" title="${esc(stamp(r.ts))}">${esc(when(r.ts))}</time></li>`).join("")}</ul>
        <p class="small"><a href="#/audit">Open the audit log →</a></p>` : `<p class="muted">Nothing yet.</p>`) : `<p class="muted">Your role doesn't include the audit log.</p>`}</section>
      <section class="card"><h2>Get started</h2><ol class="muted" style="margin:0;padding-left:18px;display:grid;gap:6px">
        <li><a href="#/people">Invite your team</a> and put people in teams.</li>
        <li><a href="#/workstations">Create an enrolment code</a> and run <span class="mono">cuff org join &lt;code&gt;</span> on each computer.</li>
        <li>Agents found on enrolled computers appear in <a href="#/agents">AI Agents</a>. You can also register agents yourself.</li>
        <li><a href="#/policies">Publish a policy</a> to cap what agents may do on every workstation.</li></ol>
        <p class="small muted">Numbers on this page are counted from what workstations reported and what admins entered. Nothing is estimated.</p></section>
    </div>`;
};

// ---- AI Agents ---------------------------------------------------------------------------------------------------------
let agentFilter = { q: "", status: "", provider: "", team_id: "" };
PAGES.agents = async (main) => {
  const [all, ws] = await Promise.all([cp("agents_list", agentFilter), cp("workstations_list")]); WS = ws;
  const providers = [...new Set(all.map((a) => a.provider).filter(Boolean))];
  main.innerHTML = head("AI Agents", "Every agent your organisation knows about: reported by enrolled workstations or registered by an admin.",
    can("agents.team") ? `<button class="btn primary" id="newagent">Register agent</button>` : "") +
    `<form class="toolbar" id="af"><input type="search" name="q" placeholder="Search name, model, provider" value="${esc(agentFilter.q)}" aria-label="Search agents">
      <select name="status" aria-label="Status">${opts(["running", "active", "idle", "awaiting_approval", "suspended", "disabled", "error"].map((s) => [s, s.replace("_", " ")]), agentFilter.status, "Any status")}</select>
      <select name="provider" aria-label="Provider">${opts([...new Set([...providers, agentFilter.provider].filter(Boolean))].map((p) => [p, p]), agentFilter.provider, "Any provider")}</select>
      <select name="team_id" aria-label="Team">${teamOpts(agentFilter.team_id, "Any team")}</select><span class="muted small">${all.length} shown</span></form>` +
    table(["Agent", "Status", "Source", "Provider / model", "Workstation", "Employee", "Team", "Last active"], all.map((a) =>
      `<tr class="click" data-id="${esc(a.id)}" tabindex="0"><td><b>${esc(a.name)}</b><span class="sub">${esc(a.description || "")}</span></td><td>${agentPill(a.status)}</td>
      <td><span class="tag">${a.source === "device" ? "Reported by workstation" : "Registered by admin"}</span></td>
      <td>${esc(a.provider || "—")}<span class="sub">${esc(a.model || "")}</span></td><td>${esc(wsName(a.workstation_id))}</td><td>${esc(person(a.employee_id))}</td><td>${esc(teamName(a.team_id))}</td>
      <td title="${esc(stamp(a.last_active))}">${esc(when(a.last_active))}</td></tr>`),
    agentFilter.q || agentFilter.status || agentFilter.provider || agentFilter.team_id ? "No agents match these filters." : "No agents yet. Enrol a workstation, or register an agent.");
  let t; const f = $("af");
  f.oninput = (e) => { clearTimeout(t); t = setTimeout(() => { agentFilter = Object.fromEntries(new FormData(f)); PAGES.agents(main); }, e.target.type === "search" ? 300 : 0); };
  f.onsubmit = (e) => e.preventDefault();
  main.querySelectorAll("tr[data-id]").forEach((r) => { r.onclick = () => agentDrawer(r.dataset.id); r.onkeydown = (e) => e.key === "Enter" && agentDrawer(r.dataset.id); });
  $("newagent") && ($("newagent").onclick = () => agentForm());
  if (agentFilter.q) { const s = f.q; s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
};

async function agentDrawer(id) {
  const a = await cp("agent_get", { id }).catch(fail); if (!a) return;
  const editable = can("agents.manage") || (ORG.me.role === "team_manager" && ORG.me.team_id && a.team_id === ORG.me.team_id);
  const d = drawer(`<h2>${esc(a.name)}</h2><p class="muted">${esc(a.description || "")}</p>${agentPill(a.status)}
    <dl class="kv"><dt>Source</dt><dd>${a.source === "device" ? "Reported by an enrolled workstation" : "Registered by an admin"}</dd>
      <dt>Provider</dt><dd>${esc(a.provider || "—")}</dd><dt>Model</dt><dd>${esc(a.model || "—")}</dd>
      <dt>Employee</dt><dd>${esc(person(a.employee_id))}</dd><dt>Team</dt><dd>${esc(teamName(a.team_id))}</dd>
      <dt>Workstation</dt><dd>${esc(wsName(a.workstation_id))}</dd>
      ${a.local_key ? `<dt>Detected as</dt><dd class="mono">${esc(a.local_key)}</dd>` : ""}
      <dt>Last active</dt><dd>${esc(stamp(a.last_active))}</dd><dt>Registered</dt><dd>${esc(stamp(a.created_at))}</dd></dl>
    ${["suspended", "disabled"].includes(a.status) ? `<div class="notice small"><b>What this does today:</b> the status is recorded, written to the audit log and sent to the workstation at its next check-in. Stopping the agent on the computer itself arrives with the kill switch in Phase 3, which will show whether each workstation confirmed it.</div>` : ""}
    ${editable ? `<div class="row" style="margin:14px 0">
      ${["suspended", "disabled"].includes(a.status) ? `<button class="btn" data-s="active">Reactivate</button>` : `<button class="btn" data-s="suspended">Suspend</button>`}
      ${a.status !== "disabled" ? `<button class="btn danger" data-s="disabled">Disable</button>` : ""}
      <button class="btn" id="aedit">Edit</button>${can("agents.manage") ? `<button class="btn ghost" id="adel">Delete</button>` : ""}</div>` : ""}
    <h2 style="font-size:14px;margin-top:20px">History</h2>
    ${a.history.length ? `<ul class="feed">${a.history.map((h) => `<li>${pill(h.outcome === "ok" ? "ok" : "warn", h.outcome)}<span>${esc(h.action)}<span class="sub">${esc(h.actor_label || "")}${h.details?.reason ? " · " + esc(h.details.reason) : ""}</span></span><time title="${esc(stamp(h.ts))}">${esc(when(h.ts))}</time></li>`).join("")}</ul>` : `<p class="muted">No history yet.</p>`}`);
  d.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => {
    const s = b.dataset.s, verb = { active: "Reactivate", suspended: "Suspend", disabled: "Disable" }[s];
    modal(`${verb} ${a.name}`, `<form class="form"><label>Reason (kept in the audit log)<textarea name="reason" rows="3" maxlength="500"></textarea></label><p class="err"></p>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn ${s === "active" ? "primary" : "danger"}">${verb}</button></div></form>`,
    async (fd) => { await cp("agent_set_status", { id: a.id, status: s, reason: fd.get("reason") }); closeModal(); toast(`${verb}d.`); agentDrawer(a.id); refreshIf("agents"); });
  }));
  $("aedit") && ($("aedit").onclick = () => agentForm(a));
  $("adel") && ($("adel").onclick = async () => {
    if (!await confirmBox("Delete agent", `Remove <b>${esc(a.name)}</b> from the registry? ${a.source === "device" ? "If the workstation still reports it, it comes back at the next check-in." : ""}`, "Delete")) return;
    try { await cp("agent_delete", { id: a.id }); closeDrawer(); toast("Deleted."); refreshIf("agents"); } catch (e) { fail(e); }
  });
}
function agentForm(a = null) {
  const tm = ORG.me.role === "team_manager";
  modal(a ? "Edit agent" : "Register agent", `<form class="form">
    <label>Name<input name="name" required maxlength="120" value="${esc(a?.name)}"></label>
    <label>Description<textarea name="description" rows="2" maxlength="2000">${esc(a?.description)}</textarea></label>
    <div class="grid cols2"><label>Provider<input name="provider" maxlength="60" placeholder="e.g. Anthropic" value="${esc(a?.provider)}"></label>
    <label>Model<input name="model" maxlength="120" value="${esc(a?.model)}"></label></div>
    <div class="grid cols2"><label>Employee<select name="employee_id">${peopleOpts(a?.employee_id)}</select></label>
    <label>Team<select name="team_id" ${tm ? "disabled" : ""}>${teamOpts(tm ? ORG.me.team_id : a?.team_id)}</select></label></div>
    <p class="err"></p><div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">${a ? "Save" : "Register"}</button></div></form>`,
  async (fd) => {
    const args = Object.fromEntries(fd); if (tm) args.team_id = ORG.me.team_id; if (a) args.id = a.id;
    for (const k of ["employee_id", "team_id"]) if (!args[k]) args[k] = null;
    if (a?.workstation_id) args.workstation_id = a.workstation_id;
    const r = await cp("agent_save", args); closeModal(); toast(a ? "Saved." : "Registered."); refreshIf("agents"); if (a) agentDrawer(r.id);
  });
}
const refreshIf = (k) => { const cur = (location.hash.match(/^#\/([a-z]+)/) || [])[1] || "overview"; if (cur === k) PAGES[k]($("main")).catch(fail); };

// ---- Workstations ------------------------------------------------------------------------------------------------------
PAGES.workstations = async (main) => {
  const [ws, codes] = await Promise.all([cp("workstations_list").then((x) => (WS = x)), can("workstations.manage") ? cp("enroll_codes_list") : Promise.resolve(null)]);
  const pv = ORG.policy_version;
  main.innerHTML = head("Workstations", "Computers enrolled with Cuff. Each has its own device key; requests it makes are signed and can't be replayed.",
    can("workstations.manage") ? `<button class="btn primary" id="newcode">Create enrolment code</button>` : "") +
    (codes ? `<section class="card" style="margin-bottom:12px"><h2>Active enrolment codes</h2>${codes.length ? table(["Code ends in", "For", "#Used", "Expires", ""], codes.map((c) =>
      `<tr><td class="mono">…${esc(c.hint)}</td><td>${esc(c.employee_id ? person(c.employee_id) : "Anyone in the organisation")}</td><td class="num">${c.uses} / ${c.max_uses}</td>
      <td title="${esc(stamp(c.expires_at))}">${esc(stamp(c.expires_at))}</td><td><button class="btn ghost sm" data-revoke="${esc(c.id)}">Revoke</button></td></tr>`), "")
      : `<p class="muted" style="margin:0">None. Create a code, then run <span class="mono">cuff org join &lt;code&gt;</span> on the computer.</p>`}</section>` : "") +
    table(["Workstation", "Connection", "Employee", "System", "#Policy", "#Agents", "Last check-in"], ws.map((w) => {
      const conn = w.status === "revoked" ? pill("bad", "Revoked") : w.connected ? pill("ok", "Connected") : w.last_seen ? pill("warn", "Not checking in") : pill("", "Never checked in");
      const pol = w.policy_version_applied == null ? "—" : `v${w.policy_version_applied}${pv && w.policy_version_applied < pv ? ` <span class="sub">behind (v${pv})</span>` : ""}`;
      return `<tr class="click" data-id="${esc(w.id)}" tabindex="0"><td><b>${esc(w.name)}</b><span class="sub mono">key ${esc(w.key_fp)}</span></td><td>${conn}</td>
        <td>${esc(person(w.employee_id))}</td><td>${esc(w.os || "—")}<span class="sub">Cuff ${esc(w.cuff_version || "?")}</span></td><td class="num">${pol}</td>
        <td class="num">${w.agents}</td><td title="${esc(stamp(w.last_seen))}">${esc(when(w.last_seen))}</td></tr>`;
    }), "No workstations yet.");
  main.querySelectorAll("[data-revoke]").forEach((b) => (b.onclick = async () => {
    try { await cp("enroll_code_revoke", { id: b.dataset.revoke }); toast("Code revoked."); PAGES.workstations(main); } catch (e) { fail(e); }
  }));
  main.querySelectorAll("tr[data-id]").forEach((r) => { const w = ws.find((x) => x.id === r.dataset.id); r.onclick = () => wsDrawer(w); r.onkeydown = (e) => e.key === "Enter" && wsDrawer(w); });
  $("newcode") && ($("newcode").onclick = codeForm);
};
function codeForm() {
  modal("Create enrolment code", `<form class="form">
    <label>Who is it for?<select name="employee_id">${peopleOpts("").replace("Unassigned", "Anyone in the organisation")}</select></label>
    <div class="grid cols2"><label>Valid for (hours)<input name="hours" type="number" min="1" max="720" value="72" required></label>
    <label>Computers it can enrol<input name="max_uses" type="number" min="1" max="500" value="1" required></label></div>
    <p class="err"></p><div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Create</button></div></form>`,
  async (fd) => {
    const r = await cp("enroll_code_create", { employee_id: fd.get("employee_id") || null, hours: +fd.get("hours"), max_uses: +fd.get("max_uses") });
    modal("Enrolment code", `<div class="form"><p class="muted" style="margin:0">Run this on the computer. The code is shown once; it expires ${esc(stamp(r.expires_at))}.</p>
      <div class="codebox">cuff org join ${esc(r.code)}</div><p class="muted small" style="margin:0">The last part of the code is your organisation key's fingerprint, so the computer can check it is talking to your organisation.</p>
      <div class="actions"><button class="btn" id="copycode">Copy</button><button class="btn primary" data-close>Done</button></div></div>`);
    $("copycode").onclick = () => navigator.clipboard.writeText(`cuff org join ${r.code}`).then(() => toast("Copied."), () => toast("Copy it by selecting the text.", true));
    refreshIf("workstations");
  });
}
function wsDrawer(w) {
  const info = w.info || {};
  const d = drawer(`<h2>${esc(w.name)}</h2>${w.status === "revoked" ? pill("bad", "Revoked") : w.connected ? pill("ok", "Connected") : pill("warn", "Not checking in")}
    <dl class="kv"><dt>Employee</dt><dd>${esc(person(w.employee_id))}</dd><dt>System</dt><dd>${esc(w.os || "—")}</dd><dt>Cuff version</dt><dd>${esc(w.cuff_version || "—")}</dd>
      <dt>Device key</dt><dd class="mono">${esc(w.key_fp)}</dd><dt>Policy applied</dt><dd>${w.policy_version_applied == null ? "—" : "v" + w.policy_version_applied} (current v${esc(ORG.policy_version ?? "—")})</dd>
      <dt>Enrolled</dt><dd>${esc(stamp(w.enrolled_at))}</dd><dt>Last check-in</dt><dd>${esc(stamp(w.last_seen))}</dd>
      ${Object.entries(info).slice(0, 12).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`).join("")}</dl>
    <p class="small"><a href="#/agents" id="wsagents">${w.agents} agent${w.agents === 1 ? "" : "s"} on this workstation →</a></p>
    ${can("workstations.manage") && w.status === "active" ? `<form class="form" id="wsf"><label>Name<input name="name" required maxlength="120" value="${esc(w.name)}"></label>
      <label>Employee<select name="employee_id">${peopleOpts(w.employee_id)}</select></label><div class="actions"><button class="btn danger" type="button" id="wsrev">Revoke access</button><button class="btn primary">Save</button></div></form>
      <p class="muted small">Revoking stops the workstation's requests at once. It keeps enforcing the last policy it received; to undo, enrol it again with a new code.</p>` : ""}`);
  $("wsagents").onclick = () => { agentFilter = { q: "", status: "", provider: "", team_id: "" }; };
  const f = d.querySelector("#wsf");
  if (f) {
    f.onsubmit = async (e) => { e.preventDefault(); try { await cp("workstation_update", { id: w.id, name: f.name.value, employee_id: f.employee_id.value || null }); toast("Saved."); closeDrawer(); refreshIf("workstations"); } catch (er) { fail(er); } };
    $("wsrev").onclick = async () => {
      if (!await confirmBox("Revoke workstation", `Revoke <b>${esc(w.name)}</b>? It will no longer be able to check in.`, "Revoke")) return;
      try { await cp("workstation_revoke", { id: w.id }); toast("Revoked."); closeDrawer(); refreshIf("workstations"); } catch (er) { fail(er); }
    };
  }
}

// ---- Employees & Teams -------------------------------------------------------------------------------------------------
PAGES.people = async (main) => {
  const m = await refreshPeople();
  const manage = can("members.manage"), teams = can("teams.manage");
  main.innerHTML = head("Employees & Teams", "People in your organisation, their roles and teams. Roles are enforced on the server.",
    manage ? `<button class="btn primary" id="invite">Invite people</button>` : "") +
    table(["Person", "Role", "Team", "Department", "Two-step", "#Workstations", "#Agents", "Status"], m.members.map((p) =>
      `<tr class="${manage ? "click" : ""}" data-id="${esc(p.id)}" tabindex="${manage ? 0 : -1}"><td><b>${esc(p.display_name || p.email)}</b>${p.display_name ? `<span class="sub">${esc(p.email)}</span>` : ""}${p.id === ORG.me.member_id ? ' <span class="tag">You</span>' : ""}</td>
      <td>${esc(ROLES[p.role])}</td><td>${esc(teamName(p.team_id))}</td><td>${esc(deptName(p.department_id))}</td><td>${p.mfa ? pill("ok", "On") : pill("", "Off")}</td>
      <td class="num">${p.workstations}</td><td class="num">${p.agents}</td><td>${p.status === "active" ? pill("ok", "Active") : pill("warn", "Suspended")}</td></tr>`), "No one yet.") +
    (manage && m.invitations.length ? `<section class="card" style="margin-top:12px"><h2>Pending invitations</h2>${table(["Email", "Role", "Team", "Expires", ""], m.invitations.map((i) =>
      `<tr><td>${esc(i.email)}</td><td>${esc(ROLES[i.role])}</td><td>${esc(teamName(i.team_id))}</td><td>${esc(stamp(i.expires_at))}</td><td><button class="btn ghost sm" data-revinv="${esc(i.id)}">Revoke</button></td></tr>`), "")}</section>` : "") +
    `<div class="grid cols2" style="margin-top:12px">
      <section class="card"><h2>Departments</h2>${STRUCT.departments.length ? `<ul class="feed">${STRUCT.departments.map((d) => `<li><span></span><span>${esc(d.name)}</span><span>${teams ? `<button class="btn ghost sm" data-dep="${esc(d.id)}">Edit</button>` : ""}</span></li>`).join("")}</ul>` : `<p class="muted">None yet.</p>`}
        ${teams ? `<button class="btn sm" id="newdep">Add department</button>` : ""}</section>
      <section class="card"><h2>Teams</h2>${STRUCT.teams.length ? `<ul class="feed">${STRUCT.teams.map((t) => `<li><span></span><span>${esc(t.name)}<span class="sub">${esc(deptName(t.department_id))} · ${t.members} member${t.members === 1 ? "" : "s"}</span></span><span>${teams ? `<button class="btn ghost sm" data-team="${esc(t.id)}">Edit</button>` : ""}</span></li>`).join("")}</ul>` : `<p class="muted">None yet.</p>`}
        ${teams ? `<button class="btn sm" id="newteam">Add team</button>` : ""}</section></div>`;
  if (manage) {
    $("invite").onclick = inviteForm;
    main.querySelectorAll("tr[data-id]").forEach((r) => { const p = m.members.find((x) => x.id === r.dataset.id); r.onclick = () => memberForm(p); r.onkeydown = (e) => e.key === "Enter" && memberForm(p); });
    main.querySelectorAll("[data-revinv]").forEach((b) => (b.onclick = async () => { try { await cp("invite_revoke", { id: b.dataset.revinv }); toast("Invitation revoked."); PAGES.people(main); } catch (e) { fail(e); } }));
  }
  if (teams) {
    $("newdep").onclick = () => structForm("department");
    $("newteam").onclick = () => structForm("team");
    main.querySelectorAll("[data-dep]").forEach((b) => (b.onclick = () => structForm("department", STRUCT.departments.find((d) => d.id === b.dataset.dep))));
    main.querySelectorAll("[data-team]").forEach((b) => (b.onclick = () => structForm("team", STRUCT.teams.find((t) => t.id === b.dataset.team))));
  }
};
const roleOpts = (sel, current) => opts(Object.entries(ROLES).filter(([r]) => mayAssign(r) || r === current), sel);
function inviteForm() {
  modal("Invite people", `<form class="form"><label>Email<input name="email" type="email" required maxlength="200"></label>
    <label>Role<select name="role">${roleOpts("employee")}</select></label>
    <div class="grid cols2"><label>Team<select name="team_id">${teamOpts("")}</select></label><label>Department<select name="department_id">${deptOpts("")}</select></label></div>
    <p class="err"></p><div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Create invitation</button></div></form>`,
  async (fd) => {
    const a = Object.fromEntries(fd); for (const k of ["team_id", "department_id"]) if (!a[k]) a[k] = null;
    const r = await cp("member_invite", a);
    const link = `${location.origin}${location.pathname}#invite=${r.token}`;
    modal("Invitation link", `<div class="form"><p class="muted" style="margin:0">Send this link to <b>${esc(a.email)}</b>. It works once, for that email address only, until ${esc(stamp(r.expires_at))}. It is shown only now.</p>
      <div class="codebox">${esc(link)}</div><div class="actions"><button class="btn" id="copyl">Copy link</button><button class="btn primary" data-close>Done</button></div></div>`);
    $("copyl").onclick = () => navigator.clipboard.writeText(link).then(() => toast("Copied."), () => toast("Copy it by selecting the text.", true));
    refreshIf("people");
  });
}
function memberForm(p) {
  const self = p.id === ORG.me.member_id;
  modal(p.display_name || p.email, `<form class="form"><label>Display name<input name="display_name" maxlength="120" value="${esc(p.display_name)}"></label>
    <label>Role<select name="role" ${self || !mayAssign(p.role) ? "disabled" : ""}>${roleOpts(p.role, p.role)}</select></label>
    <div class="grid cols2"><label>Team<select name="team_id">${teamOpts(p.team_id)}</select></label><label>Department<select name="department_id">${deptOpts(p.department_id)}</select></label></div>
    <label>Status<select name="status" ${self ? "disabled" : ""}>${opts([["active", "Active"], ["suspended", "Suspended"]], p.status)}</select></label>
    <p class="err"></p><div class="actions">${self ? "" : `<button type="button" class="btn danger" id="mrem" style="margin-right:auto">Remove</button>`}<button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div></form>`,
  async (fd) => {
    const a = { id: p.id, display_name: fd.get("display_name"), team_id: fd.get("team_id") || null, department_id: fd.get("department_id") || null };
    if (fd.has("role")) a.role = fd.get("role"); if (fd.has("status")) a.status = fd.get("status");
    await cp("member_update", a); closeModal(); toast("Saved."); refreshIf("people");
  });
  $("mrem") && ($("mrem").onclick = async () => {
    closeModal();
    if (!await confirmBox("Remove member", `Remove <b>${esc(p.email)}</b> from ${esc(ORG.name)}? Their workstations stay enrolled until you revoke them.`, "Remove")) return;
    try { await cp("member_remove", { id: p.id }); toast("Removed."); refreshIf("people"); } catch (e) { fail(e); }
  });
}
function structForm(kind, item = null) {
  const team = kind === "team";
  modal(`${item ? "Edit" : "Add"} ${kind}`, `<form class="form"><label>Name<input name="name" required maxlength="120" value="${esc(item?.name)}"></label>
    ${team ? `<label>Department<select name="department_id">${deptOpts(item?.department_id)}</select></label>` : ""}
    <p class="err"></p><div class="actions">${item ? `<button type="button" class="btn danger" id="sdel" style="margin-right:auto">Delete</button>` : ""}<button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div></form>`,
  async (fd) => {
    const a = { name: fd.get("name") }; if (item) a.id = item.id; if (team) a.department_id = fd.get("department_id") || null;
    await cp(team ? "team_save" : "department_save", a); closeModal(); toast("Saved."); refreshIf("people");
  });
  $("sdel") && ($("sdel").onclick = async () => {
    closeModal();
    if (!await confirmBox(`Delete ${kind}`, `Delete <b>${esc(item.name)}</b>? People in it stay in the organisation without a ${kind}.`, "Delete")) return;
    try { await cp(team ? "team_delete" : "department_delete", { id: item.id }); toast("Deleted."); refreshIf("people"); } catch (e) { fail(e); }
  });
}

// ---- Permissions & Policies ----------------------------------------------------------------------------------------------
PAGES.policies = async (main) => {
  const p = await cp("policy_list");
  const cur = p.versions[0], rules = cur?.rules || {};
  const capText = (r) => "max_level" in r ? `Dial capped at ${LEVELS[r.max_level]}` : "No cap on the dial";
  main.innerHTML = head("Permissions & Policies", "Policies are signed with your organisation's key. Workstations check the signature and only accept newer versions, so a tampered or replayed policy is refused.") +
    `<div class="grid cols2"><section class="card"><h2>In force</h2>${cur ? `<p style="margin:0 0 6px"><b>Version ${cur.version}</b> · ${esc(capText(rules))}</p>
      ${rules.note ? `<p class="muted" style="margin:0 0 6px">${esc(rules.note)}</p>` : ""}
      <p class="muted small" style="margin:0">Issued ${esc(stamp(cur.issued_at))} by ${esc(cur.issued_by || "—")}. Applied on <b>${cur.applied} of ${p.workstations}</b> active workstations (as they reported at check-in).</p>
      <p class="muted small">Signing key fingerprint <span class="mono">${esc(p.key_fp)}</span></p>` : `<p class="muted">No policy yet.</p>`}</section>
      <section class="card"><h2>Publish a new version</h2>${can("policy.manage") ? `<form class="form" id="pf">
        <label>Highest dial level agents may use<select name="max_level">${opts([["", "No cap"], ...LEVELS.map((l, i) => [String(i), l])], "max_level" in rules ? String(rules.max_level) : "")}</select></label>
        <label>Note for employees (optional)<input name="note" maxlength="500" value="${esc(rules.note)}"></label>
        <div class="actions"><button class="btn primary">Sign and publish</button></div></form>`
        : `<p class="muted">Only super admins and security managers publish policies.</p>`}</section></div>
    <div class="notice" style="margin:12px 0"><b>Phase 1 policy:</b> one rule, a cap on Cuff's dial, enforced by Cuff on each workstation like its folder rules. It limits what Cuff lets agents do; it does not isolate the computer beyond what the operating system's sandbox provides.
      The full engine (ALLOW, DENY and REQUIRE APPROVAL rules inherited Organisation → Department → Team → Employee → Agent) arrives in Phase 2.</div>
    <section class="card" style="margin-bottom:12px"><h2>History</h2>${table(["#Version", "Rules", "Issued", "By", "#Applied on"], p.versions.map((v) =>
      `<tr><td class="num">v${v.version}</td><td>${esc(capText(v.rules || {}))}${v.rules?.note ? `<span class="sub">${esc(v.rules.note)}</span>` : ""}</td><td>${esc(stamp(v.issued_at))}</td><td>${esc(v.issued_by || "—")}</td><td class="num">${v.applied}</td></tr>`), "No versions.")}</section>
    <section class="card" style="margin-bottom:12px"><h2>Chrome browsers</h2>
      <p class="muted small" style="margin-top:0">Cuff for Chrome limits AI agents inside the browser. Install it on every managed Chrome with the
        <span class="mono">ExtensionInstallForcelist</span> policy, then paste this into Google Admin console → Chrome → Apps &amp; extensions → Cuff AI →
        "Policy for extensions". It uses this policy's dial cap; add your protected sites to the list.</p>
      <div class="codebox" id="chromepol" style="white-space:pre">${esc(chromePolicy(rules))}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="copychrome">Copy</button>
        <span class="muted small">Windows: the same values under <span class="mono">HKLM\\Software\\Policies\\Google\\Chrome\\3rdparty\\extensions\\&lt;extension id&gt;\\policy</span>.
        macOS: a profile for <span class="mono">com.google.Chrome.extensions.&lt;extension id&gt;</span>.</span></div></section>
    <section class="card"><h2>What each role can do</h2>${table(["Permission", ...Object.values(ROLES)], [
      ["Change organisation settings", "org.settings"], ["Invite and manage people", "members.manage"], ["Manage teams and departments", "teams.manage"],
      ["Enrol and revoke workstations", "workstations.manage"], ["Manage every agent", "agents.manage"], ["Manage their team's agents", "agents.team"],
      ["Publish policies", "policy.manage"], ["Read the audit log", "audit.read"]].map(([l, k]) =>
      `<tr><td>${esc(l)}</td>${Object.keys(ROLES).map((r) => `<td>${PERMS[k].includes(r) ? pill("ok", "Yes") : '<span class="muted">—</span>'}</td>`).join("")}</tr>`), "")}
      <p class="muted small">Team managers manage agents of their own team only. Everyone can see the organisation; employees and team managers see only their own and their team's agents and workstations.</p></section>`;
  $("copychrome").onclick = () => navigator.clipboard.writeText($("chromepol").textContent).then(() => toast("Copied."), () => toast("Copy it by selecting the text.", true));
  const f = $("pf");
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const r = {}; if (f.max_level.value !== "") r.max_level = +f.max_level.value; if (f.note.value.trim()) r.note = f.note.value.trim();
    if (!await confirmBox("Publish policy", `Sign and publish version ${(cur?.version || 0) + 1}: <b>${esc(capText(r))}</b>? Workstations apply it at their next check-in (about a minute).`, "Publish", false)) return;
    try { const out = await cp("policy_publish", { rules: r }); ORG.policy_version = out.version; toast(`Version ${out.version} published.`); PAGES.policies(main); } catch (er) { fail(er); }
  };
};

// the extension's Chrome policy (extension/managed_schema.json), in Google Admin console's format
function chromePolicy(rules) {
  const v = { organization: { Value: ORG.name } };
  if ("max_level" in rules) v.max_level = { Value: rules.max_level };
  v.protected_sites = { Value: [] };
  v.block_secret_override = { Value: true };
  return JSON.stringify(v, null, 2);
}

// ---- Audit Logs ---------------------------------------------------------------------------------------------------------
let auditFilter = { q: "", action: "", outcome: "", actor_type: "", from: "", to: "" }, auditRows = [];
PAGES.audit = async (main) => {
  if (!can("audit.read")) { main.innerHTML = head("Audit Logs", "") + `<div class="notice">Your role doesn't include the audit log. Super admins, administrators and security managers can read it.</div>`; return; }
  const args = () => { const a = { limit: 200 }; for (const [k, v] of Object.entries(auditFilter)) if (v) a[k] = k === "from" ? new Date(v + "T00:00").toISOString() : k === "to" ? new Date(new Date(v + "T00:00").getTime() + 864e5).toISOString() : v; return a; };
  auditRows = await cp("audit_list", args());
  main.innerHTML = head("Audit Logs", "Every change and every workstation event, append-only. Each record carries the hash of the one before, so editing or removing any record breaks the chain.",
    `<button class="btn" id="verify">Verify chain</button><button class="btn" id="exjson">Export JSON</button><button class="btn" id="excsv">Export CSV</button>`) +
    `<p id="vres" class="small" style="margin:-6px 0 12px"></p>
    <form class="toolbar" id="lf"><input type="search" name="q" placeholder="Search" value="${esc(auditFilter.q)}" aria-label="Search the audit log">
      <input name="action" placeholder="Action starts with, e.g. agent." value="${esc(auditFilter.action)}" aria-label="Action" style="width:220px">
      <select name="outcome" aria-label="Outcome">${opts([["ok", "OK"], ["denied", "Denied"], ["failed", "Failed"]], auditFilter.outcome, "Any outcome")}</select>
      <select name="actor_type" aria-label="Actor">${opts([["user", "People"], ["device", "Workstations"], ["system", "System"]], auditFilter.actor_type, "Any actor")}</select>
      <label class="small muted">From <input type="date" name="from" value="${esc(auditFilter.from)}"></label><label class="small muted">To <input type="date" name="to" value="${esc(auditFilter.to)}"></label></form>
    <div id="arows"></div><div class="row" style="margin-top:10px"><button class="btn" id="more" hidden>Load older</button></div>`;
  const render = () => {
    $("arows").innerHTML = table(["When", "Actor", "Action", "Resource", "Outcome"], auditRows.map((r, i) =>
      `<tr class="click" data-i="${i}" tabindex="0"><td title="${esc(stamp(r.ts))}">${esc(stamp(r.ts))}</td><td>${esc(r.actor_label || r.actor_id || "—")}<span class="sub">${esc(r.actor_type === "device" ? "Workstation" : r.actor_type === "user" ? "Person" : "System")}</span></td>
      <td class="mono">${esc(r.action)}</td><td>${esc(r.resource_type || "")}<span class="sub mono">${esc((r.resource_id || "").slice(0, 36))}</span></td>
      <td>${pill(r.outcome === "ok" ? "ok" : r.outcome === "denied" ? "warn" : "bad", r.outcome)}</td></tr>`), "No records match.");
    $("arows").querySelectorAll("tr[data-i]").forEach((tr) => { const r = auditRows[+tr.dataset.i]; tr.onclick = () => auditDrawer(r); tr.onkeydown = (e) => e.key === "Enter" && auditDrawer(r); });
    $("more").hidden = auditRows.length === 0 || auditRows.length % 200 !== 0;
  };
  render();
  let t; const f = $("lf");
  f.oninput = (e) => { clearTimeout(t); t = setTimeout(async () => { auditFilter = Object.fromEntries(new FormData(f)); try { auditRows = await cp("audit_list", args()); render(); } catch (er) { fail(er); } }, ["search", "text"].includes(e.target.type) ? 350 : 0); };
  f.onsubmit = (e) => e.preventDefault();
  $("more").onclick = async () => { try { const older = await cp("audit_list", { ...args(), before: auditRows[auditRows.length - 1].id }); auditRows = auditRows.concat(older); render(); if (older.length < 200) $("more").hidden = true; } catch (e) { fail(e); } };
  $("verify").onclick = async () => {
    $("vres").textContent = "Checking…";
    try { const v = await cp("audit_verify"); $("vres").innerHTML = v.ok ? `${pill("ok", "Intact")} All ${v.checked} records check out. Latest hash <span class="mono">${esc(v.head.slice(0, 16))}…</span>`
      : `${pill("bad", "Broken")} The chain breaks at record ${esc(v.broken_at)} after ${v.checked} good records. Someone changed the log outside Cuff; treat this as a security incident.`; }
    catch (e) { $("vres").textContent = e.message; }
  };
  const dl = (name, text, type) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
  const fname = (ext) => `cuff-audit-${ORG.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.${ext}`;
  $("exjson").onclick = () => dl(fname("json"), JSON.stringify(auditRows, null, 2), "application/json");
  $("excsv").onclick = () => {
    const cols = ["id", "event_id", "ts", "actor_type", "actor_id", "actor_label", "action", "resource_type", "resource_id", "outcome", "workstation_id", "agent_id", "details", "hash"];
    const cell = (v) => { let s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    dl(fname("csv"), [cols.join(","), ...auditRows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n"), "text/csv");
  };
};
function auditDrawer(r) {
  drawer(`<h2 class="mono" style="font-size:15px">${esc(r.action)}</h2>${pill(r.outcome === "ok" ? "ok" : r.outcome === "denied" ? "warn" : "bad", r.outcome)}
    <dl class="kv"><dt>When</dt><dd>${esc(stamp(r.ts))}</dd><dt>Actor</dt><dd>${esc(r.actor_label || "—")} (${esc(r.actor_type)})</dd><dt>Actor id</dt><dd class="mono">${esc(r.actor_id || "—")}</dd>
      <dt>Resource</dt><dd>${esc(r.resource_type || "—")} <span class="mono">${esc(r.resource_id || "")}</span></dd>
      ${r.workstation_id ? `<dt>Workstation</dt><dd class="mono">${esc(r.workstation_id)}</dd>` : ""}${r.agent_id ? `<dt>Agent</dt><dd class="mono">${esc(r.agent_id)}</dd>` : ""}
      <dt>Record</dt><dd class="mono">#${esc(r.id)} · ${esc(r.event_id)}</dd><dt>Hash</dt><dd class="mono">${esc(r.hash)}</dd></dl>
    <h2 style="font-size:14px">Details</h2><pre class="codebox" style="white-space:pre-wrap">${esc(JSON.stringify(r.details ?? {}, null, 2))}</pre>`);
}

// ---- Settings ------------------------------------------------------------------------------------------------------------
PAGES.settings = async (main) => {
  ME = await cp("me"); ORG = { ...ORG, ...(await cp("org_get")) };
  const s = ORG.settings || {}, admin = can("org.settings");
  main.innerHTML = head("Settings", "") + `<div class="grid cols2">
    <section class="card"><h2>Organisation</h2>${admin ? `<form class="form" id="of">
      <label>Name<input name="name" required maxlength="120" value="${esc(ORG.name)}"></label>
      <label style="display:flex;gap:8px;align-items:center;font-weight:500;color:var(--ink)"><input type="checkbox" name="require_mfa" ${s.require_mfa ? "checked" : ""}> Require two-step sign-in for everyone who makes changes</label>
      <label>A workstation counts as connected if it checked in within (minutes)<input name="connected_minutes" type="number" min="2" max="1440" value="${esc(s.connected_minutes ?? 5)}"></label>
      <div class="actions"><button class="btn primary">Save</button></div></form>`
      : `<dl class="kv"><dt>Name</dt><dd>${esc(ORG.name)}</dd><dt>Two-step required</dt><dd>${s.require_mfa ? "Yes" : "No"}</dd></dl><p class="muted small">Only super admins change these.</p>`}
      <dl class="kv"><dt>Policy signing key</dt><dd class="mono">${esc(ORG.policy_key_fp || "—")}</dd><dt>Created</dt><dd>${esc(stamp(ORG.created_at))}</dd></dl>
      <p class="muted small">The signing key's private half is stored encrypted on the server and never leaves it; workstations pin the fingerprint when they enrol.</p></section>
    <section class="card"><h2>Your two-step sign-in</h2><div id="mfa"></div></section></div>
    <section class="card" style="margin-top:12px"><h2>Plan</h2>${planCard()}</section>`;
  const f = $("of");
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    try { await cp("org_update", { name: f.name.value, require_mfa: f.require_mfa.checked, connected_minutes: +f.connected_minutes.value }); toast("Saved."); $("orgname2").textContent = f.name.value; PAGES.settings(main); }
    catch (er) { fail(er); }
  };
  renderMfa();
};
// pricing (matches the website): Starter free up to 3 people; Team $9/person/month yearly or $11 monthly
function planCard() {
  const people = PEOPLE.filter((p) => p.status === "active").length;
  const starter = people <= 3;
  return `<p style="margin:0 0 6px">${pill("ok", "Early access")} <b>Team, free for now.</b> Company billing isn't on yet; admins get an email 30 days before anything is charged.</p>
    <dl class="kv"><dt>Active people</dt><dd>${people}</dd>
      <dt>When billing starts</dt><dd>${starter ? "Starter: free for up to 3 people" : `Team: $${people * 9}/month billed yearly ($9 × ${people}), or $${people * 11} month to month`}</dd></dl>
    <p class="muted small" style="margin:0">Business ($19 per person per month) adds approvals, live activity with a kill switch, and the security center as they are released. Enterprise is priced on request from 100 people.
      <a href="../#business" target="_blank" rel="noopener">See pricing</a></p>`;
}

function renderMfa() {
  const box = $("mfa"); if (!box) return;
  if (ME.mfa.enabled) {
    box.innerHTML = `<p>${pill("ok", "On")} You're asked for a code from your authenticator app before making changes (once every 12 hours per sign-in).</p>
      <form class="form" id="mfaoff"><label>Code, to turn it off<input name="code" inputmode="numeric" maxlength="6" required autocomplete="one-time-code"></label><p class="err"></p>
      <div class="actions"><button class="btn danger">Turn off</button></div></form>`;
    $("mfaoff").onsubmit = async (e) => { e.preventDefault(); try { await cp("mfa_disable", { code: e.target.code.value }); ME.mfa.enabled = false; toast("Two-step sign-in is off."); renderMfa(); } catch (er) { e.target.querySelector(".err").textContent = er.message; } };
  } else {
    box.innerHTML = `<p class="muted">Protect changes with a second step: a 6-digit code from an authenticator app such as 1Password, Google Authenticator or Microsoft Authenticator.</p><button class="btn primary" id="mfaset">Set up</button>`;
    $("mfaset").onclick = async () => {
      let r; try { r = await cp("mfa_setup"); } catch (e) { return fail(e); }
      box.innerHTML = `<ol class="muted" style="padding-left:18px;margin:0 0 10px"><li>Scan this with your authenticator app.</li><li>Type the 6-digit code it shows.</li></ol>
        <div id="qr" aria-label="QR code for your authenticator app"></div><p class="small muted">Can't scan? Enter this key: <span class="mono">${esc(r.secret.replace(/(.{4})/g, "$1 ").trim())}</span></p>
        <form class="form" id="mfaon"><label>Code<input name="code" inputmode="numeric" maxlength="6" required autocomplete="one-time-code"></label><p class="err"></p><div class="actions"><button class="btn primary">Turn on</button></div></form>`;
      if (window.QRCode) new QRCode($("qr"), { text: r.uri, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M }); else $("qr").hidden = true;
      $("mfaon").onsubmit = async (e) => { e.preventDefault(); try { await cp("mfa_enable", { code: e.target.code.value }); ME.mfa.enabled = true; ME.mfa.verified = true; toast("Two-step sign-in is on."); renderMfa(); } catch (er) { e.target.querySelector(".err").textContent = er.message; } };
    };
  }
}

start();
