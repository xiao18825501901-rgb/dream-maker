// OFFLINE installed-protocol boundary only; no model, account login or remote call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, root } from '../helpers.mjs';
import { readCodexMetadata, readCodexMetadataWithRoute, codexMetadataObservation } from '../../dist/server/providers/codex-status.js';
import { childEnv } from '../../dist/server/security.js';
import { controlledProxyEnvironment } from '../../dist/server/clash-service.js';
test('metadata inventory cannot dispatch a model turn and excludes account secrets',async t=>{
 const h=harness(t);
 h.config.codex={command:process.execPath,args:[resolve(root,'tests/fixtures/codex-wire.mjs'),'success','app-server'],home:h.dir,model:'fixture-not-a-model',permissionProfile:'fixture-source-read'};
 const report=await readCodexMetadata(h.config,h.dir);
 assert.equal(report.account.type,'chatgpt');
 assert.equal(report.modelTurnsRequested,0);
 assert.equal(report.cleanupReturned,true);
 assert.equal(report.configuredModelListed,true);
 assert.equal(report.actualServedModel,'NOT_VERIFIED');
 assert.equal(report.quota.ordinaryUsageAllowed,true);
 assert.equal(report.route.path,'DM_ROUTE_DISABLED');
 assert.equal(/email|access_token|refresh_token|fixture-private/.test(JSON.stringify(report)),false);
 const methods=readFileSync(resolve(h.dir,'codex-fixture-requests.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x).method);
 assert.deepEqual(methods,['initialize','account/read','model/list','account/rateLimits/read']);
});

test('RPC authentication categories survive opaque exception messages without exposing responses',async t=>{
 const h=harness(t);h.config.codex={command:process.execPath,args:[resolve(root,'tests/fixtures/codex-wire.mjs'),'auth-refusal','app-server'],home:h.dir,model:'fixture-not-a-model'};
 const report=await readCodexMetadata(h.config,h.dir),failure=report.errors.find(e=>e.method==='account/read');
 assert.match(failure.category,/AUTH_EXPIRED/);assert.match(failure.category,/AUTH_TOKEN/);assert.match(failure.category,/FORBIDDEN/);
 assert.equal(report.modelTurnsRequested,0);assert.equal(report.cleanupReturned,true);assert.doesNotMatch(JSON.stringify(report),/OFFLINE_PRIVATE_TOKEN|Bearer|refresh token/);
});

test('CFW-enabled metadata inventory must use the supplied lease-bound child environment',async t=>{
 const h=harness(t);
 h.config.clash.enabled=true;
 h.config.codex={command:process.execPath,args:[resolve(root,'tests/fixtures/codex-wire.mjs'),'success','app-server'],home:h.dir,model:'fixture-not-a-model',permissionProfile:'fixture-source-read'};
 let environmentCalls=0;
 const report=await readCodexMetadata(h.config,h.dir,extra=>{
   environmentCalls+=1;
   return controlledProxyEnvironment(childEnv(extra),'http://127.0.0.1:7890/');
 });
 assert.equal(environmentCalls,1,'one checked environment must reach both the route assertion and the child');
 assert.equal(report.account.type,'chatgpt');
 assert.equal(report.modelTurnsRequested,0);
 assert.equal(report.cleanupReturned,true);
});

test('CFW metadata runs only inside the same selector lease and exposes no model turn',async t=>{
 const h=harness(t);
 h.config.clash.enabled=true;
 h.config.codex={command:process.execPath,args:[resolve(root,'tests/fixtures/codex-wire.mjs'),'success','app-server'],home:h.dir,model:'fixture-not-a-model',permissionProfile:'fixture-source-read'};
 let leased=0,childCalls=0;
 const clash={
  async withRun(id,signal,action){leased++;assert.match(id,/codex-metadata/);return action();},
  childEnvironment(extra){childCalls++;return{...extra,HTTPS_PROXY:'http://127.0.0.1:7890/',HTTP_PROXY:'http://127.0.0.1:7890/',ALL_PROXY:'http://127.0.0.1:7890/',NO_PROXY:'127.0.0.1,localhost'};}
 };
 const report=await readCodexMetadataWithRoute(h.config,h.dir,clash,AbortSignal.timeout(5000));
 assert.equal(leased,1);assert.equal(childCalls,1);assert.equal(report.route.path,'CHILD_ENV_MATCH');assert.equal(report.modelTurnsRequested,0);
 const observation=codexMetadataObservation(report,{configurationFingerprint:'a'.repeat(64),currentConfiguration:true,controller:{selectionPolicy:'current',selectedNode:'fixture-node',expectedNode:'fixture-node'}});
 assert.equal(observation.route.state,'CFW_LEASE_BOUND_CHILD_ENVIRONMENT');
 assert.equal(observation.inference.state,'NOT_RUN');
});

test('CFW-enabled metadata inventory fails closed without a controlled environment',async t=>{
 const h=harness(t);
 h.config.clash.enabled=true;
 h.config.codex={command:process.execPath,args:[resolve(root,'tests/fixtures/codex-wire.mjs'),'success','app-server'],home:h.dir,model:'fixture-not-a-model',permissionProfile:'fixture-source-read'};
 await assert.rejects(readCodexMetadata(h.config,h.dir),{code:'CODEX_CONTROLLED_ENVIRONMENT_REQUIRED'});
});
