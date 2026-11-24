// Actual local benign child process; no credentials, model or untrusted source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../helpers.mjs';
import { withProcessOwnership } from '../../dist/server/flow/process-ownership.js';
import { capture } from '../../dist/server/process.js';
test('dispatch-bound process intent precedes launch and root exit remains distinct from descendant cleanup',async t=>{
 const h=harness(t),p=h.interviews.create('ownership','benign local child','demo');
 const result=await withProcessOwnership({store:h.store,projectId:p.id,runId:'offline-flow',dispatchId:'offline-dispatch',generation:'offline-owner'},()=>capture(process.execPath,['-e','process.stdout.write("benign-child")'],{cwd:h.dir}));
 assert.equal(result.stdout,'benign-child');assert.equal(result.code,0);
 const rows=h.store.records(p.id).filter(row=>row.kind.startsWith('OwnedProcess'));
 assert.equal(rows[0].kind,'OwnedProcessIntent');assert.ok(rows.some(row=>row.kind==='OwnedProcessRootStarted'));
 assert.equal(rows.at(-1).kind,'OwnedProcessRootExited');
 assert.ok(rows.every(row=>row.data.dispatchId==='offline-dispatch'));
 assert.equal(rows.at(-1).data.descendantsProven,false);
 assert.equal(JSON.stringify(rows).includes('benign-child'),false,'full command arguments are not reflected into public records');
});
