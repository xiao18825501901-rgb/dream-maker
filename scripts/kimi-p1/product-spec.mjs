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
const snap0 = await req("/api/projects/" + pid);
log("PRE", snap0.status, { state: snap0.body?.project?.state, questions: (snap0.body?.project?.questions ?? []).length, answered: (snap0.body?.project?.answers ?? []).filter(a => a.status === "answered").length });
const fin = await req("/api/projects/" + pid + "/finish", { notes: "Keep everything local; no accounts, no sync.", summarize: true });
log("FINISH", fin.status, fin.status === 200 ? { state: fin.body.project.state, specId: fin.body.project.specId } : fin.body);
if (fin.status !== 200) process.exit(3);
const specView = await req("/api/projects/" + pid + "/spec");
const spec = specView.body?.spec ?? specView.body;
log("SPEC_STATUS", specView.status);
log("SPEC", { id: spec?.id, hash: spec?.hash, requirementCount: (spec?.requirements ?? []).length, state: spec?.state });
for (const r of (spec?.requirements ?? []).slice(0, 3)) log("  REQ", r.id, String(r.text).slice(0, 90));
const approve = await req("/api/projects/" + pid + "/approve", { specHash: spec.hash });
log("APPROVE", approve.status, approve.status === 200 ? { state: approve.body.project.state } : approve.body);
