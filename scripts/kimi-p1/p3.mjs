const origin = "http://127.0.0.1:4317";
const boot = process.argv[2];
const login = await fetch(origin + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
if (!login.ok) { console.error("LOGIN", login.status); process.exit(2); }
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const csrf = (await login.json()).csrf;
const r = await fetch(origin + "/api/projects/project_a423df0f7d502643142a/next", { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() }, body: "{}" });
const raw = await r.text();
console.log("STATUS", r.status);
console.log("BODY", raw.slice(0, 500));
