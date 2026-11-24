const origin = "http://127.0.0.1:4317";
const boot = process.argv[2];
const out = (k, v) => console.log(k, typeof v === "string" ? v : JSON.stringify(v));
try {
    const login = await fetch(origin + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const csrf = (await login.json()).csrf;
    out("LOGIN", login.status);
    const h = { cookie, "content-type": "application/json", "x-csrf-token": csrf };
    const created = await fetch(origin + "/api/projects", { method: "POST", headers: { ...h, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ name: "KIMI_Q_PERSIST", idea: "Local log viewer: list entries by date, click to read. Local only.", mode: "live", kimiConsent: true }) });
    const cj = await created.json();
    const pid = cj.project.id;
    out("PID", pid);
    const next = await fetch(origin + "/api/projects/" + pid + "/next", { method: "POST", headers: { ...h, "idempotency-key": crypto.randomUUID() }, body: "{}" });
    const nj = await next.json();
    out("NEXT", next.status);
    out("NEXT_Q", (nj.project?.questions ?? []).length);
    // Same session, fresh read: does it persist?
    const back = await fetch(origin + "/api/projects/" + pid, { headers: { cookie } });
    const bj = await back.json();
    out("GET", back.status);
    out("GET_Q", (bj.project?.questions ?? []).length);
    const q0 = (bj.project?.questions ?? [])[0];
    if (q0) out("Q0", { topic: q0.topic, source: q0.source, text: String(q0.text).slice(0, 120) });
} catch (error) { out("THREW", String(error && error.message || error)); }
