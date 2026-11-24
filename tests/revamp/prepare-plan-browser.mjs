// Explicit synthetic UI data only. No native receipt, model call, approval or Live result.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../dist/server/store.js';
import { defaults } from '../../dist/server/config.js';
import { Interviews } from '../../dist/server/interview.js';
import { LayaBridge } from '../../dist/server/laya.js';
import { compileSpec,finalizeSpec } from '../../dist/server/compile.js';
import { fixtureProjectPlan } from '../fixtures/full-project-plan.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));
const data=resolve(root,'.runtime/revamp-20261101/browser-data');
const store=new Store(resolve(data,'dream-maker.sqlite'));
const interviews=new Interviews(store,{complete:async()=>{throw Error('NO_MODEL_IN_BROWSER_FIXTURE');}},new LayaBridge(()=>defaults),()=>defaults);
try{
 const p=interviews.create('完整方案与换路核验 · 离线数据','只验证完整方案、报告和换路的本地界面，不运行真实 Agent。','demo');
 const spec=compileSpec(p,1);spec.projectPlan=fixtureProjectPlan(spec.requirements.map(r=>({id:r.id,text:r.text,origin:'USER',sources:['description']})));
 spec.projectPlan.inputBinding={inputHash:'0'.repeat(64),interviewRevision:p.version,projectRevision:p.version};
 finalizeSpec(spec,'demo');
 store.tx(()=>{store.saveSpec(spec);p.specId=spec.id;p.state='SPEC_REVIEW';store.saveProject(p);store.record('BrowserFixture',p.id,null,{evidenceClass:'FIXED_SYNTHETIC_UI_DATA_NOT_LIVE',approvalsCreated:0,modelTurns:0});});
 console.log(JSON.stringify({projectId:p.id,data,evidenceClass:'FIXED_SYNTHETIC_UI_DATA_NOT_LIVE'}));
}finally{await interviews.close();store.close();}
