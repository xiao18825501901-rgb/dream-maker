import { readFileSync } from 'node:fs';
const origin = "http://127.0.0.1:4317";
const pid = process.argv[2];
const auth = JSON.parse(readFileSync(".runtime/session.json", "utf8"));
const log = (...a) => console.log(...a.map(x => typeof x === "string" ? x : JSON.stringify(x)));
const req = async (path, body) => {
  const r = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { cookie: auth.cookie, "content-type": "application/json", ...(body === undefined ? {} : { "x-csrf-token": auth.csrf, "idempotency-key": crypto.randomUUID() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j, raw: t.slice(0, 300) };
};
const s = await req("/api/projects/" + pid);
const spec = s.body?.spec, p = s.body?.project;
log("STATE", p?.state, "spec", spec?.hash);
const b = await req("/api/projects/" + pid + "/build", { specHash: spec.hash, approved: true });
log("BUILD", b.status, b.body ?? b.raw);
if (b.status !== 200) process.exit(6);
const runId = b.body.run.id;
let last = "";
for (let i = 0; i < 100; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const st = await req("/api/projects/" + pid);
  const run = (st.body?.runs ?? []).find(r => r.id === runId) ?? {};
  const sig = run.state + "|" + (run.tasks ?? []).map(t => t.state).join(",");
  if (sig !== last) { log("RUN", i, run.state, "phase=" + (run.phase ?? ""), "tasks=" + (run.tasks ?? []).length, (run.tasks ?? []).map(t => t.state).join(",")); last = sig; }
  if (["ACCEPTED", "FAILED", "BLOCKED", "CANCELLED", "PARTIAL", "PAUSED"].includes(run.state)) break;
}
const fin = await req("/api/projects/" + pid);
const run = (fin.body?.runs ?? []).find(r => r.id === runId) ?? {};
log("FINAL", { runState: run.state, projectState: fin.body?.project?.state, reason: run.reason, artifacts: (run.artifacts ?? []).length });
log("TASKS", (run.tasks ?? []).map(t => ({ id: t.id, the: (t.title ?? "").slice(0, 30), state: t.state })));
log("VERIF", JSON.stringify(run.verification ?? null).slice(0, 500));
