// OFFLINE Store boundary only; invalid records must stop before any OS inspector.
import test from 'node:test';import assert from 'node:assert/strict';import {harness,root} from './helpers.mjs';
import {inspectDispatchOwnership} from '../dist/server/flow/ownership-recovery.js';
function setup(t,alter){
 const h=harness(t),p=h.interviews.create('OFFLINE ownership','no model','demo'),scope={dispatchId:'offline-dispatch',generation:'offline-owner'},processId='offline-process';
 const values=[['DispatchGranted',{...scope,kind:'reviewer',mode:'live'}],['OwnedProcessIntent',{...scope,processId,commandSha256:'a'.repeat(64),argvSha256:'b'.repeat(64)}],
 ['OwnedWindowsJobIntent',{...scope,processId,jobId:'windows_job_'+'a'.repeat(20),requestSha256:'c'.repeat(64),helperSha256:'d'.repeat(64),parentPid:50,parentTicks:'639293320000000000'}],
 ['OwnedProcessRootStarted',{...scope,processId,pid:99,identity:'win32:639293327960559627',identityState:'OS_START_IDENTITY'}],['OwnedProcessRootExited',{...scope,processId,rootClosed:true,code:1,signal:null}]];
 alter(values);for(const [kind,data] of values)h.store.record(kind,p.id,'offline-run',data);
 return()=>inspectDispatchOwnership(h.store,root,h.config,p.id,'offline-run',scope.dispatchId);
}
for(const [name,alter,code] of [
 ['duplicate dispatch grant',rows=>rows.push(rows[0]),'DISPATCH_RECOVERY_GRANT_AMBIGUOUS'],
 ['duplicate root start',rows=>rows.push(rows[3]),'WINDOWS_INTENT_OBSERVATION_UNPROVEN'],
 ['cross-generation exit',rows=>{rows[4][1]={...rows[4][1],generation:'foreign-owner'};},'WINDOWS_INTENT_BINDING_INVALID'],
 ['root started before its launch intent',rows=>{[rows[2],rows[3]]=[rows[3],rows[2]];},'WINDOWS_INTENT_BINDING_INVALID']
])test('original Store refuses '+name,async t=>{const action=setup(t,alter);await assert.rejects(action(),{code});});
