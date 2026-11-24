const origin = "http://127.0.0.1:4317";
const boot = process.argv[2];
const out = (k, v) => console.log(k, typeof v === "string" ? v : JSON.stringify(v));
try {
    const login = await fetch(origin + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
    out("LOGIN", login.status);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const csrf = (await login.json()).csrf;
    const created = await fetch(origin + "/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ name: "KIMI_PRODUCT_Q", idea: "A tiny local log viewer: list entries by date, click one to read it. Local only, no cloud.", mode: "live", kimiConsent: true }) });
    const createdRaw = await created.text();
    out("CREATE", created.status);
    let pid = null; try { pid = JSON.parse(createdRaw).project.id; } catch {}
    out("PID", pid ?? createdRaw.slice(0, 200));
    if (!pid) process.exit(0);
    const next = await fetch(origin + "/api/projects/" + pid + "/next", { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() }, body: "{}" });
    const nextRaw = await next.text();
    out("NEXT_STATUS", next.status);
    out("NEXT_BODY", nextRaw.slice(0, 600));
} catch (error) {
    out("THREW", String(error && error.message || error));
}
