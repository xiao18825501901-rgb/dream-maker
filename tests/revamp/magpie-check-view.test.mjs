// OFFLINE presentation/response tests. Not a native check or model qualification.
import test from 'node:test';import assert from 'node:assert/strict';
import * as panel from '../../dist/web/magpie-check-view.js';
const value=(status='PASSED')=>({schema:'dream-maker.magpie-local-check.v1',status,checkedAt:'2026-11-03T12:00:00.000Z',reason:null,processClosed:true,accountVerified:false,modelVerified:false,customExecutionGranted:false});
test('historical local success is visibly separate from account/model/Custom readiness',()=>{
 const html=panel.magpieCheckPanel({magpieCheck:value()});assert.match(html,/上次.*通过/);assert.match(html,/账户.*模型.*尚未/);assert.match(html,/经典模式无需/);assert.doesNotMatch(html,/LIVE_READY|已登录|模型可用/);
});
test('uncertain cleanup disables a new launch but keeps reading the last result available',()=>{
 const html=panel.magpieCheckPanel({magpieCheck:{...value('UNCERTAIN'),reason:'CLEANUP_UNCERTAIN',processClosed:false}});
 assert.match(html,/<button[^>]*data-action="magpie-check"[^>]*disabled/);assert.doesNotMatch(html,/<button[^>]*data-action="magpie-read"[^>]*disabled/);assert.match(html,/尚未核清/);
});
test('a transport response cannot claim model/account authority or carry paths and private details',()=>{
 assert.deepEqual(panel.readMagpieCheck(value()),value());
 for(const edit of [{modelVerified:true},{accountVerified:true},{customExecutionGranted:true},{runtimeDirectory:'F:/PRIVATE'},{checkedAt:'<img>'},{status:'PASSED',processClosed:false},{reason:'INTERNAL_PRIVATE_CODE'}])assert.throws(()=>panel.readMagpieCheck({...value(),...edit}));
});
test('an unread or disconnected check needs a status read before another explicit launch',()=>{
 const html=panel.magpieCheckPanel({magpieNeedsRead:true,magpieCheck:value()});assert.match(html,/<button[^>]*data-action="magpie-check"[^>]*disabled/);assert.doesNotMatch(html,/<button[^>]*data-action="magpie-read"[^>]*disabled/);
});
