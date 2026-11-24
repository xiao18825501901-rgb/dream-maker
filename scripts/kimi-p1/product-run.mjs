import { readFileSync, writeFileSync } from 'node:fs';
const origin = "http://127.0.0.1:4317";
const [boot, mode, name, ideaIn] = process.argv.slice(2);
const SESSION = ".runtime/session.json";
const log = (...a) => console.log(...a.map(x => typeof x === "string" ? x : JSON.stringify(x)));
let auth;
if (boot && boot !== '-') {
  const login = await fetch(origin + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
  log("LOGIN", login.status);
  if (!login.ok) process.exit(2);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  auth = { cookie, csrf: (await login.json()).csrf };
  writeFileSync(SESSION, JSON.stringify(auth));
} else auth = JSON.parse(readFileSync(SESSION, "utf8"));
const req = async (path, body) => {
  const r = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { cookie: auth.cookie, "content-type": "application/json", ...(body === undefined ? {} : { "x-csrf-token": auth.csrf, "idempotency-key": crypto.randomUUID() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const created = await req("/api/projects", { name, idea: ideaIn, mode, kimiConsent: mode === 'live' });
log("CREATE", created.status, created.body?.project?.mode);
const pid = created.body?.project?.id;
if (!pid) { log(created.body); process.exit(3); }
log("PID", pid);
for (let i = 0; i < 12; i++) {
  const n = await req("/api/projects/" + pid + "/next", {});
  if (n.status !== 200) { log("GATE", i, n.body?.error); break; }
  const open = (n.body.project.questions ?? []).find(q => !(n.body.project.answers ?? []).some(a => a.questionId === q.id));
  if (!open) { log("NO_OPEN", i); break; }
  const a = await req("/api/projects/" + pid + "/answer", { questionId: open.id, text: "Local web page in the browser. Per-item streak. Missed day breaks the streak; allow a one-day backfill. Keep all data on this machine.", version: n.body.project.version });
  if (a.status !== 200) { log("ANSWER_FAIL", i, a.body?.error); break; }
}
const s1 = await req("/api/projects/" + pid);
log("PRE_FINISH", s1.body?.project?.state, (s1.body?.project?.answers ?? []).filter(a => a.status === 'answered').length + " answered");
const fin = await req("/api/projects/" + pid + "/finish", { notes: "Local only, no accounts, no sync.", summarize: mode === 'live' });
log("FINISH", fin.status, fin.status === 200 ? fin.body.project.state : fin.body);
if (fin.status !== 200) process.exit(4);
const s2 = await req("/api/projects/" + pid);
const spec = s2.body?.spec;
log("SPEC", { hash: spec?.hash, requirements: (spec?.requirements ?? []).length, acceptance: (spec?.acceptanceItems ?? []).length });
const ap = await req("/api/projects/" + pid + "/approve", { specHash: spec.hash });
log("APPROVE", ap.status, ap.status === 200 ? ap.body.project.state : ap.body);
if (ap.status !== 200) process.exit(5);
const b = await req("/api/projects/" + pid + "/build", { specHash: spec.hash, approved: true });
log("BUILD", b.status, b.status === 200 ? { runId: b.body.run.id, state: b.body.run.state } : b.body);
if (b.status !== 200) process.exit(6);
const runId = b.body.run.id;
let last = "";
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const s = await req("/api/projects/" + pid);
  const run = (s.body?.runs ?? []).find(r => r.id === runId) ?? {};
  const sig = run.state + "|" + (run.tasks ?? []).map(t => t.state).join(",");
  if (sig !== last) { log("RUN", i, run.state, "phase=" + (run.phase ?? ""), "tasks=" + (run.tasks ?? []).length, (run.tasks ?? []).map(t => t.state).join(",")); last = sig; }
  if (["ACCEPTED", "FAILED", "BLOCKED", "CANCELLED", "PARTIAL", "PAUSED"].includes(run.state)) break;
}
const fin2 = await req("/api/projects/" + pid);
const run = (fin2.body?.runs ?? []).find(r => r.id === runId) ?? {};
log("FINAL", { runState: run.state, projectState: fin2.body?.project?.state, reason: run.reason, artifacts: (run.artifacts ?? []).length, tasks: (run.tasks ?? []).map(t => t.id + ":" + t.state) });
log("VERIFICATION", JSON.stringify(run.verification ?? null).slice(0, 400));
