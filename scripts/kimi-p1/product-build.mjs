const origin = "http://127.0.0.1:4317";
const [boot, pid] = process.argv.slice(2);
const log = (...a) => console.log(...a.map(x => typeof x === "string" ? x : JSON.stringify(x)));
const login = await fetch(origin + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
log("LOGIN", login.status);
if (!login.ok) process.exit(2);
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const csrf = (await login.json()).csrf;
const req = async (path, body) => {
  const r = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json", ...(body === undefined ? {} : { "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const snap1 = await req("/api/projects/" + pid);
const spec = snap1.body?.spec;
log("SNAP", snap1.status, { state: snap1.body?.project?.state, specHash: spec?.hash, requirementCount: (spec?.requirements ?? []).length, acceptance: (spec?.acceptanceItems ?? []).length });
for (const r of (spec?.requirements ?? []).slice(0, 4)) log("  REQ", r.id, String(r.text).slice(0, 80), "<=", (r.sourceAnswerIds ?? []).length, "answers");
if (!spec?.hash) process.exit(3);
const approve = await req("/api/projects/" + pid + "/approve", { specHash: spec.hash });
log("APPROVE", approve.status, approve.status === 200 ? { state: approve.body.project.state } : approve.body);
if (approve.status !== 200) process.exit(4);
const build = await req("/api/projects/" + pid + "/build", { specHash: spec.hash, approved: true });
log("BUILD", build.status, build.status === 200 ? { runId: build.body.run?.id, state: build.body.run?.state } : build.body);
if (build.status !== 200) process.exit(5);
const runId = build.body.run.id;
let last = "";
for (let i = 0; i < 90; i++) {
  await new Promise(r => setTimeout(r, 4000));
  const s = await req("/api/projects/" + pid);
  const run = (s.body?.runs ?? []).find(r => r.id === runId) ?? {};
  const sig = run.state + "|" + (run.tasks ?? []).map(t => t.state).join(",") + "|" + (run.tasks ?? []).length;
  if (sig !== last) { log("RUN", i, run.state, "tasks=" + (run.tasks ?? []).length, (run.tasks ?? []).map(t => t.state).join(",")); last = sig; }
  if (["ACCEPTED", "FAILED", "BLOCKED", "CANCELLED", "PAUSED", "PARTIAL"].includes(run.state)) break;
}
const fin = await req("/api/projects/" + pid);
const run = (fin.body?.runs ?? []).find(r => r.id === runId) ?? {};
log("FINAL", { runState: run.state, projectState: fin.body?.project?.state, tasks: (run.tasks ?? []).map(t => ({ id: t.id, title: (t.title ?? "").slice(0, 40), state: t.state })) });
