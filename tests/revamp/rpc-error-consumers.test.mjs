// OFFLINE shared error semantics, no model/identity/runtime qualification.
import test from 'node:test';import assert from 'node:assert/strict';
test('DSH host timeout survives removal of remote error text',async()=>{
 const rpc=await import('../../dist/server/providers/rpc.js'),dsh=await import('../../dist/server/providers/dsh.js');
 assert.equal(typeof rpc.RpcChildError,'function');assert.equal(typeof dsh.translateDshRpcError,'function');
 const remote=new rpc.RpcChildError(rpc.rpcErrorEvidence('dm/run',{code:-32000,message:'run timeout reached; OFFLINE_PRIVATE'}));
 assert.equal(remote.message,'RUNNER_RPC_ERROR');assert.equal(dsh.translateDshRpcError(remote,false).code,'DSH_HOST_TIMEOUT');
 assert.equal(dsh.translateDshRpcError(remote,true).code,'DSH_HOST_STALLED');
 assert.doesNotMatch(JSON.stringify(remote),/OFFLINE_PRIVATE|run timeout reached/);
});
