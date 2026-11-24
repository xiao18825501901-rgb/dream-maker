// Actual local SQLite accounting with offline prices. No provider/model calls or real approvals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {existsSync} from 'node:fs';
import {dirname} from 'node:path';
import { NativeBudget } from '../../dist/server/native-budget.js';
import { harness } from '../helpers.mjs';
const authority={scopeId:'OFFLINE_USER_LIMIT',authorizationHash:'OFFLINE_AUTH_NOT_LIVE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
const actor='local-session:'+'a'.repeat(64);
const price=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
function setup(t,auth=authority){let b;t.after(()=>b?.close());const h=harness(t),path=resolve(h.dir,'user-limit.sqlite');const open=()=>{b=new NativeBudget(path,auth,()=>true);return b;};return {b:open(),path,open};}
test('ordinary user policy is initially unset and reading it does not create or reset accounting',t=>{
 const {b}=setup(t),before=b.summary(),count=b.requests().length;
 assert.equal(b.userBudgetStatus().configured,false);assert.equal(b.userBudgetStatus().unlimited,false);
 assert.deepEqual(b.summary(),before);assert.equal(b.requests().length,count);
 assert.equal(b.db.prepare("SELECT 1 FROM sqlite_master WHERE name='user_budget_limits'").get(),undefined);
});

test('explicit uncapped CNY preserves old consumption, disabled USD, revision history and restart state',t=>{
 const auth={...authority,mode:'UNCAPPED',uncappedApproval:{approvedAt:new Date().toISOString(),approvedBy:'USER',statement:'OFFLINE TEST AUTHORITY ONLY',evidenceRef:'OFFLINE_NOT_A_LIVE_RECEIPT',supersedes:[]}},h=setup(t,auth),b=h.b;
 b.configureUserBudget({CNY:3000000,USD:0},0,actor,'OFFLINE_CAPPED_FIRST');
 const request=b.reserve('executor',price(),128);b.settle(request.id,null,'OFFLINE_UNKNOWN');const before=JSON.stringify(b.requests());
 const status=b.configureUserBudget({CNY:null,USD:0},1,actor,'OFFLINE_EXPLICIT_UNCAPPED');
 assert.equal(status.unlimited,true);assert.equal(status.limits.CNY,null);assert.equal(status.byCurrency.CNY.remainingMicros,null);
 assert.equal(status.byCurrency.CNY.committedMicros,request.reservedMicros);assert.equal(status.baselineRequests,0);
 assert.equal(JSON.stringify(b.requests()),before);assert.equal(b.db.prepare('SELECT count(*) n FROM user_budget_limits').get().n,2);
 assert.equal(b.configureUserBudget({CNY:null,USD:0},1,actor,'OFFLINE_EXPLICIT_UNCAPPED').revision,2);
 assert.throws(()=>b.reserve('executor',{...price(),currency:'USD'},128),{code:'USER_BUDGET_CURRENCY_DISABLED'});
 const next=b.reserve('executor',price(),128);b.settle(next.id,null,'OFFLINE_UNKNOWN_AFTER_UNCAP');b.close();
 const restored=h.open().userBudgetStatus();assert.equal(restored.unlimited,true);assert.equal(restored.limits.USD,0);
 assert.equal(restored.byCurrency.CNY.committedMicros,request.reservedMicros+next.reservedMicros);
});

test('uncapped selection cannot enlarge a capped authority or change a policy during an in-flight request',t=>{
 const {b}=setup(t);assert.throws(()=>b.configureUserBudget({CNY:null,USD:0},0,actor,'OFFLINE_UNAUTHORIZED_UNCAP'),{code:'USER_BUDGET_ABOVE_AUTHORITY'});
 assert.throws(()=>b.configureUserBudget({CNY:1000000,USD:null},0,actor,'OFFLINE_UNAUTHORIZED_USD'),{code:'NATIVE_PRICE_CURRENCY_NOT_AUTHORIZED'});
 assert.equal(b.userBudgetStatus().configured,false);b.configureUserBudget({CNY:3000000,USD:0},0,actor,'OFFLINE_FIXED');
 const request=b.reserve('executor',price(),128);
 assert.throws(()=>b.configureUserBudget({CNY:null,USD:0},1,actor,'OFFLINE_UNCAP_DURING_REQUEST'),{code:'NATIVE_REQUEST_ALREADY_IN_FLIGHT'});
 assert.equal(b.userBudgetStatus().revision,1);b.settle(request.id,null,'OFFLINE_UNKNOWN');
});
test('user cap is checked before the next reservation and failed/unknown requests stay charged',t=>{
 const {b}=setup(t);const saved=b.configureUserBudget({CNY:3000000,USD:0},0,actor,'OFFLINE_OP_1');
 assert.equal(saved.revision,1);assert.equal(saved.configured,true);
 const first=b.reserve('executor',price(),128);b.settle(first.id,null,'OFFLINE_FAILED_RESPONSE');
 const used=b.userBudgetStatus().byCurrency.CNY.committedMicros;assert.equal(used,first.reservedMicros);
 assert.throws(()=>b.reserve('executor',price(),128),{code:'USER_BUDGET_LIMIT'});assert.equal(b.requests().length,1);
 assert.equal(b.userBudgetStatus().byCurrency.CNY.committedMicros,used);
});
test('changing a limit preserves its baseline, consumption, history and operation identity',t=>{
 const {b}=setup(t),old=b.reserve('executor',price(),128);b.settle(old.id,{inputTokens:100,outputTokens:1,cacheHitTokens:0},'OFFLINE_BEFORE_USER_LIMIT');
 const historical=b.summary().committedMicros,first=b.configureUserBudget({CNY:4000000,USD:0},0,actor,'OFFLINE_START');
 assert.equal(first.byCurrency.CNY.committedMicros,0);assert.equal(b.requests().length,1);assert.equal(b.summary().committedMicros,historical);
 const request=b.reserve('executor',price(),128);b.settle(request.id,null,'OFFLINE_UNKNOWN');
 const changed=b.configureUserBudget({CNY:3000000,USD:0},1,actor,'OFFLINE_CHANGE');assert.equal(changed.revision,2);
 assert.equal(changed.baselineRequests,1);assert.equal(changed.byCurrency.CNY.committedMicros,request.reservedMicros);
 assert.throws(()=>b.reserve('executor',price(),128),{code:'USER_BUDGET_LIMIT'});
 assert.throws(()=>b.configureUserBudget({CNY:3000000,USD:0},1,actor,'OFFLINE_LATE'),{code:'USER_BUDGET_REVISION_CONFLICT'});
 const replay=b.configureUserBudget({CNY:3000000,USD:0},1,actor,'OFFLINE_CHANGE');assert.equal(replay.revision,2);
 assert.throws(()=>b.configureUserBudget({CNY:5000000,USD:0},1,actor,'OFFLINE_CHANGE'),{code:'IDEMPOTENCY_CONFLICT'});
 assert.equal(b.requests().length,2);
});
test('restart keeps the user cap and an unresolved request consumes its conservative upper bound',t=>{
 const h=setup(t);h.b.configureUserBudget({CNY:3000000,USD:0},0,actor,'OFFLINE_START');const request=h.b.reserve('executor',price(),128);h.b.close();
 const next=h.open(),state=next.userBudgetStatus();assert.equal(state.revision,1);assert.equal(state.byCurrency.CNY.committedMicros,request.reservedMicros);
 assert.equal(next.requests()[0].usageStatus,'UNKNOWN');assert.throws(()=>next.reserve('executor',price(),128),{code:'USER_BUDGET_LIMIT'});
});
test('probe permits and an old uncapped authority cannot bypass a zero user cap or authorize another currency',t=>{
 const auth={...authority,mode:'UNCAPPED',uncappedApproval:{approvedAt:new Date().toISOString(),approvedBy:'USER',statement:'OFFLINE TEST AUTHORITY ONLY',evidenceRef:'OFFLINE_NOT_A_LIVE_RECEIPT',supersedes:[]}};
 const {b}=setup(t,auth);b.configureUserBudget({CNY:0,USD:0},0,actor,'OFFLINE_STOP');const permit=b.beginEvidenceRepair('executor');
 assert.throws(()=>b.reserve('executor',price(),128,permit),{code:'USER_BUDGET_CURRENCY_DISABLED'});
 assert.throws(()=>b.reserve('executor',{...price(),currency:'USD'},128,permit),{code:'USER_BUDGET_CURRENCY_DISABLED'});
 assert.equal(b.requests().length,0);b.endEvidenceRepair(permit);
});
test('a changed legacy baseline or a conflicting in-flight update fails closed without clearing requests',t=>{
 const {b}=setup(t),old=b.reserve('executor',price(),128);b.settle(old.id,{inputTokens:100,outputTokens:1,cacheHitTokens:0},'OFFLINE_BASELINE');
 b.configureUserBudget({CNY:3000000,USD:0},0,actor,'OFFLINE_START');const active=b.reserve('executor',price(),128);
 assert.throws(()=>b.configureUserBudget({CNY:4000000,USD:0},1,actor,'OFFLINE_DURING_CALL'),{code:'NATIVE_REQUEST_ALREADY_IN_FLIGHT'});
 b.settle(active.id,null,'OFFLINE_FAILED');b.db.prepare('DELETE FROM requests WHERE id=?').run(old.id);
 assert.throws(()=>b.preflight(price(),128),{code:'USER_BUDGET_HISTORY_MISMATCH'});
});
test('invalid or stale limit changes do not create schema or backups, and scope authority stays stricter',t=>{
 const {b,path}=setup(t),backup=resolve(dirname(path),'migration-backups');
 assert.throws(()=>b.configureUserBudget({CNY:50000000,USD:0},1,actor,'OFFLINE_BAD_VERSION'),{code:'USER_BUDGET_REVISION_CONFLICT'});
 assert.equal(existsSync(backup),false);
 assert.throws(()=>b.configureUserBudget({CNY:50000001,USD:0},0,actor,'OFFLINE_TOO_HIGH'),{code:'USER_BUDGET_ABOVE_AUTHORITY'});
 assert.throws(()=>b.configureUserBudget({CNY:1000000,USD:1},0,actor,'OFFLINE_USD_NOT_AUTHORIZED'),{code:'NATIVE_PRICE_CURRENCY_NOT_AUTHORIZED'});
 assert.equal(b.userBudgetStatus().configured,false);assert.equal(existsSync(backup),false);
 assert.throws(()=>b.reserve('executor',{...price(),currency:'USD'},128),{code:'NATIVE_PRICE_CURRENCY_NOT_AUTHORIZED'});
 assert.equal(b.requests().length,0);
});
