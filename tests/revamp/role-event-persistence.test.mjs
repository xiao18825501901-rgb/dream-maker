import test from 'node:test';
import assert from 'node:assert/strict';
import {roleEventRecord} from '../../dist/server/role-event-persistence.js';

const ownership={dispatchId:'dispatch_fixture',generation:'7'};
const requestPath={method:'dm/codexRequestPath',params:{schema:'dream-maker.codex-request-path.v1',role:'reviewer'}};

test('request-level Codex diagnostics use their own event type without recovery ownership fields',()=>{
 const record=roleEventRecord(requestPath,true,ownership);
 assert.deepEqual(record,{type:'network.codex-request',payload:requestPath.params});
 assert.equal('dispatchId' in record.payload,false);
 assert.equal('generation' in record.payload,false);
});

test('ordinary role events preserve existing agent-event and review-supplement persistence',()=>{
 const ordinary={method:'dm/codexCompletion',params:{role:'reviewer'}};
 assert.deepEqual(roleEventRecord(ordinary,false,ownership),{type:'agent.event',payload:ordinary});
 assert.deepEqual(roleEventRecord(ordinary,true,ownership),{type:'agent.event',payload:{...ordinary,dispatchId:'dispatch_fixture',generation:'7'}});
});
