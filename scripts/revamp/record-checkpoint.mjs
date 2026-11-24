import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { within } from '../../dist/server/security.js';
const root=fileURLToPath(new URL('../..',import.meta.url));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:12_000_000});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const logIndex=process.argv.indexOf('--test-log');if(logIndex<0)throw Error('EXPLICIT_TEST_LOG_REQUIRED');
const testLog=process.argv[logIndex+1],rawLog=readFileSync(within(root,testLog),'utf8');
const stat=name=>{const m=rawLog.match(new RegExp('(?:^|\\n)\\s*[ℹ#]\\s+'+name+'\\s+(\\d+)(?:\\r?\\n|$)'));if(!m)throw Error('TEST_LOG_COUNT_MISSING_'+name);return Number(m[1]);};
const rootTests={tests:stat('tests'),pass:stat('pass'),fail:stat('fail'),skip:stat('skipped'),cancelled:stat('cancelled'),log:testLog,logSha256:sha(rawLog)};
if(!rootTests.tests||rootTests.tests!==rootTests.pass+rootTests.fail+rootTests.skip+rootTests.cancelled)throw Error('TEST_LOG_COUNT_MISMATCH');
const ledgerAt=path=>{const db=new DatabaseSync(path,{readOnly:true});try{const rows=db.prepare('SELECT data FROM requests').all().map(row=>JSON.parse(row.data));return{requests:rows.length,pending:rows.filter(row=>row.usageStatus==='PENDING').length,chargedMicros:rows.reduce((out,row)=>{out[row.price.currency]=(out[row.price.currency]??0)+(row.chargedMicros??0);return out;},{CNY:0,USD:0})};}finally{db.close();}};
const ledgerBefore=ledgerAt(resolve(root,'.runtime/revamp-20261101/budget-before.sqlite')),ledgerNow=ledgerAt(resolve(root,'.runtime/controller/native-budget.sqlite'));
if(ledgerNow.requests<ledgerBefore.requests)throw Error('BUDGET_HISTORY_REGRESSION');
const output=resolve(root,'docs/revamp/evidence/checkpoint-'+new Date().toISOString().replace(/[^0-9T]/g,''));mkdirSync(output,{recursive:true});
const paths=[...new Set(git('ls-files','--cached','--others','--exclude-standard','--','AGENTS.md','package.json','tsconfig.json','tsconfig.web.json','src','dist','migrations','prompts','scripts','tests').trim().split(/\r?\n/).filter(Boolean))].sort();
const source=paths.map(path=>({path,sha256:sha(readFileSync(resolve(root,path)))}));
const sourceHash=sha(JSON.stringify(source));
writeFileSync(resolve(output,'source-files.json'),JSON.stringify({sourceHash,files:source},null,2)+'\n',{flag:'wx'});
const report=JSON.parse(readFileSync(resolve(root,'.runtime/revamp-20261101/public-research-20261031T211641999/report.json'),'utf8'));
writeFileSync(resolve(output,'public-research.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const matrixPath=resolve(root,'docs/revamp/REQUIREMENT_IMPLEMENTATION_MATRIX.json');
const matrix=JSON.parse(readFileSync(matrixPath,'utf8'));
const proof={W02:['tests/revamp/plan-versions.test.mjs','scripts/revamp/verify-plan-migration.mjs'],W03:['tests/revamp/interview-choices.test.mjs','tests/revamp/interview-view.test.mjs','docs/revamp/evidence/W03/browser-observations.json'],W04:['tests/revamp/repository-clients.test.mjs','tests/revamp/project-research.test.mjs','tests/revamp/research-http.test.mjs','docs/revamp/RESEARCH_BOUNDARY.md'],W05:['tests/revamp/reuse.test.mjs','tests/revamp/test_source_zip.py','tests/revamp/source-assessment.test.mjs'],W06:['tests/revamp/p1-planning.test.mjs','tests/revamp/project-plan-view.test.mjs'],W07:['tests/revamp/role-policy.test.mjs','tests/revamp/codex-metadata.test.mjs','tests/revamp/codex-cwd.test.mjs'],W08:['tests/revamp/dispatch-queue.test.mjs','tests/revamp/engine-dispatch.test.mjs','tests/revamp/windows-job.test.mjs','tests/revamp/process-ownership.test.mjs','tests/revamp/rpc-close.test.mjs','docs/revamp/W08_DISPATCH_CONTRACT.md'],W09:['tests/revamp/flow-conclusion.test.mjs','tests/revamp/flow-http.test.mjs'],W10:['tests/revamp/flow-help-view.test.mjs','docs/revamp/evidence/W09/browser-observations.json']};
proof.W11=['tests/revamp/laya-role-scope.test.mjs','tests/revamp/flow-choice-view.test.mjs','docs/revamp/W11_ROLE_ASSISTANCE_CONTRACT.md','docs/revamp/evidence/W11/ui-observations.json'];
proof.W12=['tests/revamp/dreamflow-entry.test.mjs','tests/revamp/user-plan-view.test.mjs','tests/windows-lifecycle.test.mjs','docs/revamp/W12_STANDALONE_CONTRACT.md','docs/revamp/evidence/W12/sqlite-observations.json'];
proof.W13=['tests/revamp/onboarding.test.mjs','tests/revamp/onboarding-view.test.mjs','tests/revamp/user-budget.test.mjs','tests/revamp/user-budget-http.test.mjs','tests/revamp/user-budget-owner.test.mjs','docs/revamp/W13_SETUP_STATUS_CONTRACT.md','docs/revamp/evidence/W13/browser-observations.json','docs/revamp/evidence/W13/sqlite-observations.json'];
proof.W15=['tests/revamp/maintenance-state.test.mjs','tests/revamp/maintenance-http.test.mjs','tests/revamp/maintenance-view.test.mjs','tests/revamp/maintenance-controller.test.mjs','tests/revamp/interview-close.test.mjs','tests/revamp/application-close.test.mjs','tests/revamp/engine-close.test.mjs','tests/revamp/startup-cleanup.test.mjs','tests/revamp/native-owner-stop.test.mjs','tests/revamp/native-cleanup-close.test.mjs','docs/revamp/W15_STATE_BACKUP_CONTRACT.md','docs/revamp/W15_LIFECYCLE_CONTRACT.md','docs/revamp/evidence/W15/browser-observations.json','docs/revamp/evidence/W15/sqlite-observations.json'];
proof.W15.push('tests/revamp/engine-pause-all.test.mjs','tests/revamp/lifecycle-http.test.mjs','tests/revamp/lifecycle-view.test.mjs','docs/revamp/evidence/W15/lifecycle/observations.json');
proof.W16=['src/server/release/component-inventory.mjs','src/server/release/local-component.ts','scripts/revamp/inventory-windows-components.mjs','tests/revamp/release-components.test.mjs','docs/revamp/W16_COMPONENT_INVENTORY_CONTRACT.md'];
for(const item of matrix.requirements){
 for(const file of item.targetFiles)file.present=existsSync(resolve(root,file.path));
 item.relatedSubsystemEvidence=[...new Set(item.tasks.flatMap(task=>proof[task]??[]))];
 if(item.relatedSubsystemEvidence.length)item.implementationStatus='PARTIAL_SUBSYSTEM_IMPLEMENTED';
 item.coverageLimitation='Subsystem evidence is not complete requirement or product Live acceptance.';
}
matrix.sourceHash=sourceHash;matrix.head=git('rev-parse','HEAD').trim();matrix.lastCheckedAt=new Date().toISOString();
writeFileSync(matrixPath,JSON.stringify(matrix,null,2)+'\n');
const status={at:matrix.lastCheckedAt,head:matrix.head,branch:git('branch','--show-current').trim(),sourceHash,diffSha256:sha(git('diff','--binary')),
 rootTests,pythonTests:{status:'SEPARATE_PYTHON_TEST_LOG_REQUIRED_FOR_CURRENT_COUNTS'},
 ledgerBefore,ledgerNow,ledgerDeltaRequests:ledgerNow.requests-ledgerBefore.requests,
 nativeRoleAcceptance:'NOT_RUN',overall:'PARTIAL',next:'W08 multiple executor workspaces/controlled merge and event supervision; complete W05 trusted positive source admission; W11-W18 including live roles and full releases'};
writeFileSync(resolve(output,'status.json'),JSON.stringify(status,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,head:status.head,sourceHash,sourceFiles:source.length,overall:status.overall}));
