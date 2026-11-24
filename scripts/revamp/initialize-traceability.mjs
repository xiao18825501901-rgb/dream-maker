// Mechanical mapping of the verified kit's exact requirements to the existing product.
// Initial receipts are exclusive writes so rerunning cannot erase progress or history.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../..', import.meta.url));
assert.equal(process.argv[2], '--kit'); assert.equal(process.argv.length, 4);
const kit = resolve(process.argv[3]);
const trace = JSON.parse(readFileSync(resolve(kit, 'REQUIREMENT_TRACEABILITY.json'), 'utf8'));
assert.equal(trace.coverage.length, 88);
const targets = {
 W00:['docs/revamp/DEVELOPMENT_OWNER_RECEIPT.md','docs/continuation/'],
 W01:['src/shared/types.ts','src/server/store.ts','docs/revamp/MIGRATION_PLAN.md'],
 W02:['src/server/store.ts','src/server/interview.ts','src/server/engine.ts','migrations/002_plan_versions.sql','tests/revamp/plan-versions.test.mjs'],
 W03:['src/server/interview.ts','prompts/planner1.md','src/web/views.ts','src/web/ui.ts'],
 W04:['src/server/research/','src/server/http.ts','src/server/security.ts'],
 W05:['src/server/research/','src/server/compile.ts','src/server/export.ts'],
 W06:['src/server/interview.ts','src/server/providers/model.ts','src/server/kimi-admission.ts'],
 W07:['src/server/engine.ts','src/server/providers/codex.ts','src/server/native-owner.ts'],
 W08:['src/server/engine.ts','src/server/native-owner.ts','src/server/store.ts','src/server/process.ts'],
 W09:['src/server/engine.ts','src/server/interview.ts','src/server/flows.ts'],
 W10:['src/web/ui.ts','src/web/views.ts','src/web/contracts.ts','src/web/style.css'],
 W11:['src/server/laya.ts','src/server/laya-observer.ts','src/server/engine.ts','src/web/views.ts'],
 W12:['src/server/main.ts','src/server/flows.ts','src/server/server-lock.ts'],
 W13:['src/server/config.ts','src/server/native-owner.ts','src/web/views.ts'],
 W14:['src/server/providers/','src/server/config.ts'],
 W15:['src/server/store.ts','src/server/server-lock.ts','src/server/main.ts','scripts/'],
 W16:['scripts/','package.json','docs/revamp/'],
 W17:['tests/','docs/revamp/evidence/'],
 W18:['docs/revamp/REQUIREMENT_IMPLEMENTATION_MATRIX.json','docs/continuation/']
};
const git = (...args) => execFileSync('git', args, { cwd: root, encoding:'utf8', windowsHide:true }).trim();
const baseline = {schema:'dream-maker.revamp-baseline.v1',at:new Date().toISOString(),
 root, takeoverHead:'f62b78e41476a645dce9c8dd020d24c8f26efe36', head:git('rev-parse','HEAD'), branch:git('branch','--show-current'),
 originalBranch:'integration/kimi-p1-20261017',originalTreeWasClean:true,
 writerReceipt:'docs/revamp/DEVELOPMENT_OWNER_RECEIPT.md',
 kitSha256:'1c2baf4ecbf5eb866dfd8dee9498e140787838c70343e6b97a611a7f99393de8',
 kitVerification:{files:92,result:'PASS'},
 independentKitTests:{javascript:{pass:110,fail:0},python:{pass:7,fail:1,reason:'Windows ZipInfo normalizes the raw backslash negative-test fixture before writing'}},
 originalTests:{tests:794,pass:785,fail:0,skip:9,log:'.runtime/revamp-20261101/baseline-tests.log'},
 preservedLedger:{requests:2424,maxRequests:2600,pending:0,phase:'REPRESENTATIVE',authorityMode:'UNCAPPED',chargedMicros:{CNY:4961244432,USD:319558},developmentAuthorizationIsNotProductDefault:true},
 originalData:{projects:24,specs:11,runs:55,workspaceLeases:0},
 roles:{planner1:'Existing Kimi binding preserved; current availability NOT_VERIFIED',planner2:'DEGRADED_SAME_VENDOR DeepSeek; target independent Codex NOT_VERIFIED',executor:'Existing DSH preserved',reviewer:'DEGRADED_SAME_VENDOR DeepSeek; target independent Codex NOT_VERIFIED'},
 newPaidRequestsByThisRevamp:0,productLiveAcceptance:'NOT_RUN',
 dataBackups:['.runtime/revamp-20261101/project-before.sqlite','.runtime/revamp-20261101/budget-before.sqlite']};
const matrix = {schema:'dream-maker.requirement-implementation-matrix.v1',at:baseline.at,source:'Dream_Maker_Codex_Revamp_Kit_20261101/REQUIREMENT_TRACEABILITY.json',
 overall:'PARTIAL', requirementCount:88, requirements:trace.coverage.map(r=>({id:r.requirementId,group:r.group,confirmedText:r.confirmedText,
 tasks:r.targetTasks,kitContribution:r.kitContribution,
 targetFiles:[...new Set(r.targetTasks.flatMap(t=>targets[t]??[]))].map(path=>({path,present:existsSync(resolve(root,path))})),
 implementationStatus:'PENDING_ITEM_REVIEW',offlineEvidence:[],localRuntimeEvidence:[],liveEvidence:[],acceptanceStatus:'NOT_VERIFIED'}))};
const dir=resolve(root,'docs/revamp');mkdirSync(dir,{recursive:true});
for(const [name,value]of [['BASELINE_CURRENT.json',baseline],['REQUIREMENT_IMPLEMENTATION_MATRIX.json',matrix]])
 writeFileSync(resolve(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({requirements:matrix.requirementCount,head:baseline.head,branch:baseline.branch,acceptance:'NOT_VERIFIED'}));
