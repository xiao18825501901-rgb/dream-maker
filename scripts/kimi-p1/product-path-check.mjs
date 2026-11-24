const origin = "http://127.0.0.1:4317";
const boot = process.argv[2];
const login = await fetch(origin + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
if (!login.ok) { console.error("LOGIN_FAILED", login.status); process.exit(1); }
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const csrf = (await login.json()).csrf;
const call = async (path, body) => {
    const res = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json", ...(body === undefined ? {} : { "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let parsed = null; try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
};
const status = await call("/api/kimi/status");
console.log("KIMI_STATUS", JSON.stringify(status.body));
const diag = await call("/api/diagnostics");
console.log("DIAG", JSON.stringify({ bridge: diag.body.bridge, kimi: diag.body.kimi?.note }));
const created = await call("/api/projects", { name: "KIMI_PRODUCT_PATH", idea: "A tiny local log viewer that lists entries by date and shows one entry on click; local only.", mode: "live", kimiConsent: true });
console.log("CREATE", created.status, JSON.stringify(created.body).slice(0, 300));
