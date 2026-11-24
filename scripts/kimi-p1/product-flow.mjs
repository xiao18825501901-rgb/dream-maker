const origin = "http://127.0.0.1:4317";
const boot = process.argv[2];
const log = (...a) => console.log(...a.map(x => typeof x === "string" ? x : JSON.stringify(x)));
const login = await fetch(origin + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
if (!login.ok) { log("LOGIN", login.status); process.exit(2); }
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const csrf = (await login.json()).csrf;
const req = async (path, body) => {
    const r = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json", ...(body === undefined ? {} : { "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
};
const created = await req("/api/projects", { name: "KIMI_TEN_Q", idea: "Local habit checklist: add items, tick daily, see a 7-day streak. Local only, data stays on this machine.", mode: "live", kimiConsent: true });
log("CREATE", created.status);
const pid = created.body?.project?.id;
log("PID", pid);
if (!pid) process.exit(1);
let asked = 0, answered = 0, gateAt = null;
for (let i = 0; i < 14; i++) {
    const n = await req("/api/projects/" + pid + "/next", {});
    if (n.status !== 200) { gateAt = n.body?.error ?? n.status; log("NEXT_STOP", i, gateAt); break; }
    const qs = n.body.project.questions ?? [];
    asked = qs.length;
    const open = qs.find(q => !(n.body.project.answers ?? []).some(a => a.questionId === q.id));
    if (!open) { log("NO_OPEN_QUESTION", i); break; }
    const a = await req("/api/projects/" + pid + "/answer", { questionId: open.id, text: "Use my own notes; keep it simple and local.", version: n.body.project.version });
    if (a.status !== 200) { log("ANSWER_STOP", i, a.body?.error ?? a.status); break; }
    answered = (a.body.project.answers ?? []).filter(x => x.status === "answered").length;
    log("ROUND", i + 1, "asked=" + asked, "answered=" + answered);
}
const snap = await req("/api/projects/" + pid);
const p = snap.body?.project ?? {};
log("FINAL", { state: p.state, questions: (p.questions ?? []).length, answered: (p.answers ?? []).filter(x => x.status === "answered").length });
log("TEN_GATE", gateAt);
