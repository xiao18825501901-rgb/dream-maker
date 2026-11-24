import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeDispatch } from '../../dist/server/flow/scheduler.mjs';
test('executor cap does not consume the route, supervisor or verifier lanes',()=>{
 const task=(id,kind,demand)=>({id,projectId:'project1',flowId:'flow1',workspaceKey:'work1',kind,dependsOn:[],reads:[],writes:[],exclusiveResources:[],demand});
 const route=task('route','DETERMINISTIC',{routeSlots:1,executorSlots:0});
 const sup=task('sup','MODEL',{cpu:1,memoryMiB:512,supervisorSlots:1,executorSlots:0,externalModelSlots:1});
 const a=task('execa','MODEL',{cpu:1,memoryMiB:512,executorSlots:1,externalModelSlots:1});
 const b={...a,id:'execb'};
 const out=proposeDispatch({tasks:[route,sup,a,b],activeIds:['route'],capacity:{cpu:2,memoryMiB:2048,routeSlots:1,supervisorSlots:1,executorSlots:2,externalModelSlots:2},activeFlowByProject:{project1:'flow1'},userMaxExecutors:1});
 assert.ok(out.taskIds.includes('sup'));assert.ok(out.taskIds.includes('execa'));assert.equal(out.taskIds.includes('execb'),false);
});
