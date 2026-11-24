// Explicit OFFLINE ownership observation seam; never OS or Native evidence.
import {mock} from 'node:test';
mock.module('../../dist/server/flow/ownership-recovery.js',{namedExports:{inspectDispatchOwnership:async(...args)=>{
 args[7]({scope:'OFFLINE_DEFERRED_INTERRUPTED_REVIEW',dispatchId:args[5]});
 return {schema:'dream-maker.dispatch-recovery.v1',dispatchId:args[5],proven:true,basisSha256:'a'.repeat(64)};
}}});
await import('../revamp/interrupted-review.test.mjs');
