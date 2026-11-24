const origin = "http://127.0.0.1:4317";
const boot = process.argv[2];
const login = await fetch(origin + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
if (!login.ok) { console.error("LOGIN_FAILED", login.status); process.exit(1); }
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const csrf = (await login.json()).csrf;
const res = await fetch(origin + "/api/projects/project_a423df0f7d502643142a/next", { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) });
const body = await res.json().catch(() => null);
console.log("NEXT", res.status);
const q = body?.project?.questions ?? [];
console.log("QUESTIONS", Array.isArray(q) ? q.length : "n/a");
if (Array.isArray(q) && q.length) console.log("LAST_Q", JSON.stringify(q[q.length - 1]).slice(0, 400));
if (body && body.error) console.log("ERROR", JSON.stringify(body).slice(0, 300));
