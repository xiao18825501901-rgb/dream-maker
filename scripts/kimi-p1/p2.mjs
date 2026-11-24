const origin = "http://127.0.0.1:4317";
const boot = process.argv[2];
const login = await fetch(origin + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const r = await fetch(origin + "/api/projects/project_a423df0f7d502643142a", { headers: { cookie } });
const b = await r.json();
const p = b.project ?? {};
console.log(JSON.stringify({ state: p.state, questions: (p.questions ?? []).length, first: (p.questions ?? [])[0] ?? null }).slice(0, 400));
