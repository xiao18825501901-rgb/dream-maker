// B6 controlled experiment: a rotation whose durable outcome CANNOT be confirmed.
//
// Real session + real authority + real ledger + the real UI summary. The ONLY fake is the store,
// which silently keeps the previous record — the honest simulation of "the write may or may not
// have landed". No token leaves the process, no network, no model.
import { createBridgeSession } from "../../dist/server/kimi-bridge-session.js";
import { createKimiCredentialAuthority } from "../../dist/server/kimi-credential-authority.js";
import { createBridgeFrameLedger } from "../../dist/server/kimi-bridge-ledger.js";
import { encodeFrame, PROTOCOL_VERSION, STORAGE_NAME } from "../../dist/server/kimi-bridge-frames.js";
import { summarizeBridgeDurability } from "../../dist/web/kimi-status-summary.js";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); };
const token = (n) => ({ accessToken: "acc_" + n, refreshToken: "ref_" + n, expiresAt: 1_700_000_000_000 + n, expiresIn: 3600, scope: "kimi-code", tokenType: "Bearer" });

// A store whose write is applied once (the seed) and then silently ignored: read-back disagrees.
let record = null;
let writes = 0;
const store = {
  async save(_n, value) { writes += 1; if (writes === 1) record = structuredClone(value); },
  async load() { return record ?? undefined; },
  async loadRecord() { return record == null ? { status: "MISSING" } : { status: "OK", record: structuredClone(record) }; },
  async remove() { record = null; },
  async list() { return record ? ["kimi-code"] : []; }
};

const authority = createKimiCredentialAuthority({ store, clock: () => 1_700_000_000_000 });
await authority.restore();
await authority.commit({ token: token(1), generation: 1, messageId: "seed" });

const ledger = createBridgeFrameLedger();
const sentBytes = [];
const session = createBridgeSession({
  instanceId: "ctl-b6", accountRef: "kimi:synthetic-b6",
  send: bytes => sentBytes.push(bytes),
  authority,
  onFrame: f => ledger.record(f)
});
await session.start();

// The bridge offers a rotation to generation 2; the write will not be provable afterwards.
session.onBytes(encodeFrame({ type: "ROTATE", protocolVersion: PROTOCOL_VERSION, instanceId: "ctl-b6", storageName: STORAGE_NAME, generation: 2, messageId: "rot2", accountRef: "kimi:synthetic-b6", token: token(2) }));
await new Promise(r => setTimeout(r, 60));

const snapshot = ledger.snapshot();
const sent = session.sent().map(f => f.type + (f.generation ? "#" + f.generation : "") );
const acked = session.sent().some(f => f.type === "COMMIT_ACK");
const errorFrame = session.sent().find(f => f.type === "ERROR");

check("an unprovable rotation is never acknowledged", acked === false, "sent=" + JSON.stringify(sent));
check("the channel names it an uncertain commit", errorFrame?.code === "KIMI_AUTH_COMMIT_UNCERTAIN", "code=" + String(errorFrame?.code));
check("the ledger keeps the rotation without an ACK", snapshot.lastRotateGeneration === 2 && snapshot.lastAckGeneration === null, JSON.stringify({ rotate: snapshot.lastRotateGeneration, ack: snapshot.lastAckGeneration }));
check("the in-memory credential is not advanced on an unproven write", authority.current().generation === 1, "generation=" + authority.current().generation);

const line = summarizeBridgeDurability({ topology: "connector", running: true, error: null, frames: snapshot });
// Either branch is honest: with an ERROR frame the code branch wins and says the last commit is
// unconfirmed; without one the rotate>ack branch says the same thing in generation terms.
check("the UI line calls it unconfirmed and does not ask for a login", /未被确认|尚未确认|对账/.test(line.headline + line.detail) && line.needsLogin === false, line.level + " | " + line.headline + " / " + line.detail);
console.log("SNAPSHOT " + JSON.stringify(snapshot));
console.log("UI " + line.level + " | " + line.headline + " | " + line.detail);

const failed = results.filter(r => !r.ok);
console.log("B6_EXPERIMENT " + (failed.length === 0 ? "OK" : "FAILED") + " " + results.length + " checks");
if (failed.length > 0) process.exitCode = 1;