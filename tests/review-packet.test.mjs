// Controller source/SQLite/Demo tests only. No native model or Live qualification.
import test from "node:test";
import assert from "node:assert/strict";
import {writeFileSync,mkdirSync,readFileSync,unlinkSync} from "node:fs";
import {resolve} from "node:path";
import {harness,ready} from "./helpers.mjs";
import {hash} from "../dist/server/security.js";
import {treeHash} from "../dist/server/workspace.js";
// Reviewer prompts are a JSON packet optionally followed by trusted controller
// instructions; keep parsing the packet prefix instead of assuming the whole
// string is JSON.
const packetOf=prompt=>{
  const raw=String(prompt);let depth=0,inString=false,escape=false,end=-1;
  for(let i=0;i<raw.length;i++){
    const ch=raw[i];
    if(inString){if(escape)escape=false;else if(ch==="\\")escape=true;else if(ch==='"')inString=false;continue;}
    if(ch==='"')inString=true;else if(ch==="{")depth++;else if(ch==="}"&&--depth===0){end=i;break;}
  }
  if(end<0)throw new Error("review prompt has no JSON packet");
  return JSON.parse(raw.slice(0,end+1));
};

test("reviewer receives byte-complete source history and raw tests from the real Demo engine",async t=>{
 const h=harness(t),{p,s}=await ready(h);let packet;
 const role=h.engine.role.bind(h.engine);
 h.engine.role=async(r,name,prompt,signal)=>{if(name==="reviewer")packet=packetOf(prompt);return role(r,name,prompt,signal);};
 const r=h.engine.create(p.id,s.hash,true);await h.engine.settled(r.id);
 assert.equal(h.store.run(r.id).state,"READY_FOR_DELIVERY");
 assert.equal(packet.schema,"dream-maker.review-packet.v1");
 assert.equal(packet.runId,r.id);assert.equal(packet.spec.hash,s.hash);
 const current=packet.sourceHistory.at(-1);
 assert.equal(current.treeHash,treeHash(r.workspace));
 const html=current.files.find(f=>f.path==="index.html");
 assert.match(html.content,/<!doctype html>/i);
 assert.equal(html.content,readFileSync(resolve(r.workspace,"index.html"),"utf8"));
 assert.equal(hash(Buffer.from(html.content,html.encoding)),html.sha256);
 assert.ok(packet.changes.some(c=>c.entries.some(e=>e.kind==="added")));
 assert.equal(packet.rawTests.at(-1).recordId,h.store.run(r.id).verification.evidenceId);
 assert.match(packet.rawTests.at(-1).data.stdout,/PASS|pass|assertions/);
 assert.equal(packet.rawTests.at(-1).data.code,0);
 const saved=h.store.records(p.id,"ReviewPacket");assert.equal(saved.length,1);
 assert.equal(saved[0].data.sha256,hash(packet));
});

async function module(){return import("../dist/server/review-packet.js");}
test("snapshot preserves UTF-8 and binary bytes exactly, not paths alone",async t=>{
 const h=harness(t),{captureSource}=await module();
 const workspace=resolve(h.dir,"source");mkdirSync(workspace);
 writeFileSync(resolve(workspace,"source.txt"),"first\nsecond\r\n");
 writeFileSync(resolve(workspace,"bom.txt"),Buffer.from([0xef,0xbb,0xbf,0x41]));
 writeFileSync(resolve(workspace,"image.bin"),Buffer.from([0xff,0,0x80,42]));
 const snap=captureSource(workspace,{runId:"r",specHash:"s"},"BASELINE");
 for(const f of snap.files){assert.equal(hash(Buffer.from(f.content,f.encoding)),f.sha256);assert.equal(Buffer.from(f.content,f.encoding).length,f.bytes);}
 assert.equal(snap.files.find(f=>f.path==="image.bin").encoding,"base64");
 assert.equal(snap.treeHash,treeHash(workspace));
});

async function records(t){
 const h=harness(t),{p,s}=await ready(h),m=await module();
 const workspace=resolve(h.dir,"source");mkdirSync(workspace);
 const r={id:"offline_run",mode:"demo",projectId:p.id,specHash:s.hash,specId:s.id,workspace,plan:{tasks:[]},findings:[],verification:null};
 function snapshot(stage){const snap=m.captureSource(workspace,{runId:r.id,specHash:s.hash},stage);h.store.record("SourceSnapshot",p.id,r.id,snap);r.treeHash=snap.treeHash;return snap;}
 snapshot("BASELINE");writeFileSync(resolve(workspace,"app.txt"),"original source");snapshot("EXECUTOR_AFTER");snapshot("VERIFIER_INPUT");
 const data={stepId:"step",attempt:1,specHash:s.hash,treeHash:r.treeHash,command:["trusted-verifier"],stdout:"raw tests\r\nPASS",stderr:"",code:0,at:new Date().toISOString(),scope:"DEMO_TEMPLATE_ONLY"};
 const evidenceId=h.store.record("Evidence",p.id,r.id,data);r.verification={ok:true,evidenceId,treeHash:r.treeHash};
 return {h,p,s,m,r,snapshot,data,evidenceId};
}
test("packet declares the raw verifier history complete and explains the attempt field",async t=>{
 const x=await records(t);
 const packet=x.m.buildReviewPacket(x.h.store,x.r,x.s);
 // A reviewer must be able to tell "no earlier verification step ran" from
 // "earlier evidence was withheld". Without this, a run whose first verification
 // step already passed looks like a packet missing attempts 1..N-1.
 assert.ok(packet.verificationHistory,"VERIFICATION_HISTORY_MISSING");
 assert.equal(packet.verificationHistory.scope,"COMPLETE");
 assert.equal(packet.verificationHistory.attemptField,"RUN_STEP_INDEX");
 assert.equal(packet.verificationHistory.count,packet.rawTests.length);
 assert.deepEqual(packet.verificationHistory.evidenceRecordIds,packet.rawTests.map(r=>r.recordId));
 assert.equal(packet.verificationHistory.latestRecordId,x.evidenceId);
 assert.match(packet.verificationHistory.note,/step index/i);
});
test("verificationHistory tracks every raw attempt in order, including failures",async t=>{
 const x=await records(t);
 const failed=x.h.store.record("Evidence",x.p.id,x.r.id,{...x.data,code:1,stdout:"raw failed assertion"});
 const latest=x.h.store.record("Evidence",x.p.id,x.r.id,{...x.data,code:0,stdout:"raw latest pass"});
 x.r.verification.evidenceId=latest;
 const packet=x.m.buildReviewPacket(x.h.store,x.r,x.s);
 assert.equal(packet.verificationHistory.count,3);
 assert.deepEqual(packet.verificationHistory.evidenceRecordIds,[x.evidenceId,failed,latest]);
 assert.equal(packet.verificationHistory.latestRecordId,latest);
});
test("packet contains byte-backed added/modified/deleted changes and all failed raw test attempts",async t=>{
 const x=await records(t);x.data.code=1;x.data.stdout="raw failed assertion";x.h.store.record("Evidence",x.p.id,x.r.id,x.data);
 x.r.verification.evidenceId=x.h.store.record("Evidence",x.p.id,x.r.id,{...x.data,code:0,stdout:"raw latest pass"});
 writeFileSync(resolve(x.r.workspace,"app.txt"),"changed source");x.snapshot("EXECUTOR_AFTER");x.snapshot("VERIFIER_INPUT");
 writeFileSync(resolve(x.r.workspace,"removed.txt"),"deleted source bytes");x.snapshot("EXECUTOR_BEFORE");
 unlinkSync(resolve(x.r.workspace,"removed.txt"));x.snapshot("EXECUTOR_AFTER");x.snapshot("VERIFIER_INPUT");
 x.r.verification.evidenceId=x.h.store.record("Evidence",x.p.id,x.r.id,{...x.data,treeHash:x.r.treeHash,code:0,stdout:"raw latest pass"});
 const packet=x.m.buildReviewPacket(x.h.store,x.r,x.s);
 assert.ok(packet.changes.some(c=>c.entries.some(e=>e.kind==="modified")));
 assert.ok(packet.changes.some(c=>c.entries.some(e=>e.kind==="deleted")));
 assert.ok(packet.sourceHistory.some(s=>s.files.some(f=>f.content==="deleted source bytes")));
 assert.ok(packet.rawTests.some(e=>e.data.code===1));
 assert.equal(packet.sourceHistory.at(-1).files[0].content,"changed source");
});
for(const [name,mutate,code] of [
 ["missing baseline",x=>x.h.store.db.prepare("DELETE FROM records WHERE kind='SourceSnapshot' AND json_extract(data,'$.stage')='BASELINE'").run(),"REVIEW_SOURCE_BASELINE_REQUIRED"],
 ["missing raw verifier",x=>x.h.store.db.prepare("DELETE FROM records WHERE id=?").run(x.evidenceId),"REVIEW_RAW_EVIDENCE_REQUIRED"],
 ["stale verifier tree",x=>x.r.treeHash="0".repeat(64),"REVIEW_SOURCE_TREE_MISMATCH"],
 ["mutated workspace",x=>writeFileSync(resolve(x.r.workspace,"app.txt"),"unexpected mutation"),"REVIEW_SOURCE_TREE_MISMATCH"],
 ["foreign verification ID",x=>{x.r.verification.evidenceId="foreign";},"REVIEW_RAW_EVIDENCE_REQUIRED"],
 ["corrupted stored source",x=>x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.files[0].content','tampered') WHERE kind='SourceSnapshot' AND json_array_length(json_extract(data,'$.files'))>0").run(),"REVIEW_SOURCE_SNAPSHOT_CORRUPT"]
])test("packet rejects "+name+" before reviewer dispatch",async t=>{const x=await records(t);mutate(x);assert.throws(()=>x.m.buildReviewPacket(x.h.store,x.r,x.s),{code});});
test("complete material over the packet bound is rejected, never truncated",async t=>{
 const x=await records(t);
 assert.throws(()=>x.m.buildReviewPacket(x.h.store,x.r,{...x.s,masterPrompt:"x".repeat(2*1024*1024+1)}),{code:"REVIEW_PACKET_LIMIT"});
});
test("oversized source is refused before the controller persists a snapshot",async t=>{
 const x=await records(t);
 // The current packet contract is 2 MiB; each file stays below the independent artifact-read limit.
 for(let i=0;i<3;i++)writeFileSync(resolve(x.r.workspace,`large-${i}.txt`),"x".repeat(800000));
 assert.throws(()=>x.m.captureSource(x.r.workspace,{runId:x.r.id,specHash:x.s.hash},"EXECUTOR_AFTER"),{code:"REVIEW_PACKET_LIMIT"});
});
test("missing controller evidence stops the Engine before any reviewer call",async t=>{
 const h=harness(t),{p,s}=await ready(h);let reviewerCalls=0;
 const role=h.engine.role.bind(h.engine),advance=h.engine.advance.bind(h.engine);
 h.engine.role=async(r,name,prompt,signal)=>{if(name==="reviewer")reviewerCalls++;return role(r,name,prompt,signal);};
 h.engine.advance=(rid,phase,apply)=>{advance(rid,phase,apply);if(phase==="REVIEWING")h.store.db.prepare("DELETE FROM records WHERE kind='Evidence' AND run_id=?").run(rid);};
 const r=h.engine.create(p.id,s.hash,true);await h.engine.settled(r.id);
 assert.equal(reviewerCalls,0);assert.equal(h.store.run(r.id).state,"BLOCKED");
 assert.equal(h.store.run(r.id).reason,"REVIEW_RAW_EVIDENCE_REQUIRED");
});
test("spec mismatch and another run's evidence cannot supply the review",async t=>{
 const x=await records(t);
 assert.throws(()=>x.m.buildReviewPacket(x.h.store,x.r,{...x.s,hash:"foreign"}),{code:"REVIEW_SPEC_BINDING_CHANGED"});
 x.h.store.db.prepare("UPDATE records SET run_id='other_run' WHERE kind='Evidence'").run();
 assert.throws(()=>x.m.buildReviewPacket(x.h.store,x.r,x.s),{code:"REVIEW_RAW_EVIDENCE_REQUIRED"});
});
test("source secrets and sensitive filenames are rejected rather than silently rewritten",async t=>{
 const h=harness(t),m=await module(),workspace=resolve(h.dir,"source");mkdirSync(workspace);
 writeFileSync(resolve(workspace,"app.txt"),"sk-"+"A".repeat(30));
 assert.throws(()=>m.captureSource(workspace,{runId:"r",specHash:"s"},"BASELINE"),{code:"SECRET_IN_ARTIFACT"});
 unlinkSync(resolve(workspace,"app.txt"));writeFileSync(resolve(workspace,".env"),"not a real credential");
 assert.throws(()=>m.captureSource(workspace,{runId:"r",specHash:"s"},"BASELINE"),{code:"SENSITIVE_ARTIFACT_DENIED"});
});
