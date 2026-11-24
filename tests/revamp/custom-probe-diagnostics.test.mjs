// OFFLINE: lifecycle and redaction only; no model or qualification evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../../dist/server/flow/custom-probe-runtime.js';
const receipt={id:'OFFLINE_REQUEST',upstreamHttpStatus:400,upstreamRequestIdSha256:'a'.repeat(64),transportErrorCode:null,networkFailureClass:'HTTP_400_BAD_REQUEST',upstreamContentType:'application/json',protocolEventCount:3,protocolLastEventType:'response.created',protocolLastEventDetail:'response.created:OFFLINE',protocolFailureStage:'OBSERVE',upstreamBodyShape:'JSON_OBJECT',upstreamBodyBytes:23,upstreamBodySha256:'b'.repeat(64),upstreamBodyCode:'OFFLINE_ERROR',elapsedMs:12,elapsedMsCapped:false,completionObserved:false,responseModelMatched:false,outcome:'MODEL_GATEWAY_UPSTREAM_FAILURE',recordedAt:'2026-11-18T00:00:00Z',upstream:'SECRET_URL',responseId:'PRIVATE',body:'PRIVATE_BODY'};
test('failed probe preserves settled HTTP diagnosis without response payload or raw identity',async()=>{
 let closed=false,ended=0;const events=[];
 await runtime.finishCustomProbeRuntime({async close(){closed=true;},receipts(){assert.ok(closed);return[receipt];}},e=>events.push(e),()=>ended++);
 assert.equal(ended,1);assert.equal(events.length,1);
 assert.equal(events[0].method,'dm/customProbeGatewayReceipt');
 assert.equal(events[0].params.upstreamHttpStatus,400);
 assert.equal(events[0].params.id,'OFFLINE_REQUEST');
 assert.equal(events[0].params.upstreamContentType,'application/json');
 assert.equal(events[0].params.protocolEventCount,3);
 assert.equal(events[0].params.protocolLastEventType,'response.created');
 assert.equal(events[0].params.protocolLastEventDetail,'response.created:OFFLINE');
 assert.equal(events[0].params.protocolFailureStage,'OBSERVE');
 assert.equal(events[0].params.upstreamBodyShape,'JSON_OBJECT');
 assert.equal(events[0].params.upstreamBodyBytes,23);
 assert.equal(events[0].params.upstreamBodySha256,'b'.repeat(64));
 assert.equal(events[0].params.upstreamBodyCode,'OFFLINE_ERROR');
 assert.equal(events[0].params.responseModelMatched,false);
 assert.equal(events[0].params.outcome,'MODEL_GATEWAY_UPSTREAM_FAILURE');
 for(const secret of ['SECRET_URL','PRIVATE','PRIVATE_BODY'])assert.ok(!JSON.stringify(events).includes(secret));
});
test('failed cleanup still ends the opaque permit and never fabricates cleanup success',async()=>{
 let ended=0;const events=[];
 await assert.rejects(runtime.finishCustomProbeRuntime({async close(){throw Error('CLEANUP_FAILED');},receipts(){return[receipt];}},e=>events.push(e),()=>ended++),/CLEANUP_FAILED/);
 assert.equal(ended,1);assert.equal(events.length,0);
});
test('receipt persistence failure cannot leak the budget permit',async()=>{
 let ended=0;
 await assert.rejects(runtime.finishCustomProbeRuntime({async close(){},receipts(){return[receipt];}},()=>{throw Error('STORE_FAILED');},()=>ended++),/STORE_FAILED/);
 assert.equal(ended,1);
});
