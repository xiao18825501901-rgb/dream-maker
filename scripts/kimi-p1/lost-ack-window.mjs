// B6b controlled crash window: the durable commit succeeds, but the COMMIT_ACK never reaches the
// peer because the channel dies at that exact instant. Real session + real authority + real store.
import { createBridgeSession } from "../../dist/server/kimi-bridge-session.js";
import { createKimiCredentialAuthority } from "../../dist/server/kimi-credential-authority.js";
import { createBridgeFrameLedger } from "../../dist/server/kimi-bridge-ledger.js";
import { encodeFrame, PROTOCOL_VERSION, STORAGE_NAME } from "../../dist/server/kimi-bridge-frames.js";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); };
const token = (n) => ({ accessToken: "acc_" + n, refreshToken: "ref_" + n, expiresAt: 1_700_000_000_000 + n, expiresIn: 3600, scope: "kimi-code", tokenType: "Bearer" });
let record = null;
let writes = 0;
const store = {
  async save(_n, v) { writes += 1; record = structuredClone(v); },
  async load() { return record ?? undefined; },
  async loadRecord() { return record == null ? { status: "MISSING" } : { status: "OK", record: structuredClone(record) }; },
  async remove() { record = null; },
  async list() { return record ? ["kimi-code"] : []; }
};
const authority = createKimiCredentialAuthority({ store, clock: () => 1_700_000_000_000 });
await authority.restore();
await authority.commit({ token: token(1), generation: 1, messageId: "seed" });

// --- session 1: the channel dies exactly when the ACK would be written ---
const ledger1 = createBridgeFrameLedger();
let diedOnAck = false;
const session1 = createBridgeSession({
  instanceId: "ctl-crash", accountRef: "kimi:synthetic-crash",
  send: bytes => {
    const text = bytes.toString("utf8").slice(4);
    let frame = {};
    try { frame = JSON.parse(text); } catch { }
    if (frame.type === "COMMIT_ACK") { diedOnAck = true; throw new Error("channel died before the ACK"); }
  },
  authority,
  onFrame: (f, d) => ledger1.record(f, d)
});
await session1.start();
const writesBefore = writes;
session1.onBytes(encodeFrame({ type: "ROTATE", protocolVersion: PROTOCOL_VERSION, instanceId: "ctl-crash", storageName: STORAGE_NAME, generation: 2, messageId: "rot2", accountRef: "kimi:synthetic-crash", token: token(2) }));
await new Promise(r => setTimeout(r, 80));
check("the durable commit happened even though the ACK died", writes > writesBefore && authority.current().generation === 2, "writes=" + writes + " gen=" + authority.current().generation);
check("no COMMIT_ACK reached the peer", session1.sent().every(f => f.type !== "COMMIT_ACK"), JSON.stringify(session1.sent().map(f => f.type)));
check("the session is closed after the channel died", session1.closed() === true && diedOnAck === true);

// --- restart: a new session must restore the NEWER generation, not the old one ---
const restarted = createKimiCredentialAuthority({ store, clock: () => 1_700_000_000_000 });
await restarted.restore();
const ledger2 = createBridgeFrameLedger();
const captured = [];
const session2 = createBridgeSession({
  instanceId: "ctl-crash", accountRef: "kimi:synthetic-crash",
  send: bytes => captured.push(JSON.parse(bytes.toString("utf8").slice(4))),
  authority: restarted,
  onFrame: (f, d) => ledger2.record(f, d)
});
await session2.start();
const restore = captured.find(f => f.type === "RESTORE");
check("restart restores the rotation whose ACK was lost", restore?.generation === 2 && restore?.token?.accessToken === "acc_2", JSON.stringify({ gen: restore?.generation }));

// --- the peer retries the same rotation: idempotent replay, no second write ---
const writesBeforeReplay = writes;
session2.onBytes(encodeFrame({ type: "ROTATE", protocolVersion: PROTOCOL_VERSION, instanceId: "ctl-crash", storageName: STORAGE_NAME, generation: 2, messageId: "rot2", accountRef: "kimi:synthetic-crash", token: token(2) }));
await new Promise(r => setTimeout(r, 80));
const ack = captured.find(f => f.type === "COMMIT_ACK");
// The wire frame has no replay flag by design (the peer only needs "this id is committed"); what
// matters is that the replay produced an ACK WITHOUT a second write.
check("the replayed rotation is acknowledged", ack?.generation === 2 && ack?.messageId === "rot2", "ack=" + JSON.stringify(ack));
check("no double write on replay", writes === writesBeforeReplay, "writes=" + writes);

const failed = results.filter(r => !r.ok);
console.log("LOST_ACK_WINDOW " + (failed.length === 0 ? "OK" : "FAILED") + " " + results.length + " checks");
if (failed.length > 0) process.exitCode = 1;