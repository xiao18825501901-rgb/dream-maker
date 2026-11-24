import { readFileSync } from 'node:fs';
const origin = "http://127.0.0.1:4317";
const pid = process.argv[2];
const auth = JSON.parse(readFileSync(".runtime/session.json", "utf8"));
const log = (...a) => console.log(...a.map(x => typeof x === "string" ? x : JSON.stringify(x)));
const req = async (path) => {
  const r = await fetch(origin + path, { headers: { cookie: auth.cookie } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j, raw: t.slice(0, 300) };
};
let last = "";
const seen = new Set();
for (let i = 0; i < 120; i++) {
  const st = await req("/api/projects/" + pid);
  const runs = st.body?.runs ?? [];
  const run = runs[runs.length - 1] ?? {};
  const sig = run.id + "|" + run.state + "|" + (run.tasks ?? []).map(t => t.state).join(",");
  if (sig !== last) {
    log("RUN", i, run.id, run.state, "phase=" + (run.phase ?? ""), "calls=" + (run.calls ?? 0), "tasks=" + (run.tasks ?? []).length, (run.tasks ?? []).map(t => t.id + ":" + t.state).join(","));
    last = sig;
  }
  for (const e of (st.body?.events ?? [])) if (!seen.has(e.id) && String(e.type ?? "").startsWith("run.")) { seen.add(e.id); log("  EV", e.type, JSON.stringify(e.data ?? {}).slice(0, 140)); }
  if (run.state && ["ACCEPTED", "FAILED", "BLOCKED", "CANCELLED", "PARTIAL", "PAUSED", "READY_FOR_DELIVERY"].includes(run.state)) break;
  await new Promise(r => setTimeout(r, 3000));
}
const fin = await req("/api/projects/" + pid);
const runs = fin.body?.runs ?? [];
const run = runs[runs.length - 1] ?? {};
log("FINAL", { runId: run.id, runState: run.state, projectState: fin.body?.project?.state, reason: run.reason, artifacts: (run.artifacts ?? []).length, repairs: run.repairCount });
log("VERIF", JSON.stringify(run.verification ?? null).slice(0, 600));
log("ARTIFACTS", (run.artifacts ?? []).map(a => a.path ?? a.id).slice(0, 10));
