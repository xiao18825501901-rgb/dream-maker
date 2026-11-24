/** Build local browser assets only, using existing developer tooling. Never upload. */
import { readFileSync, writeFileSync, cpSync, existsSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv.length>2)throw Error('LOCAL_ONLY_BUILD_NO_PUBLISH_ARGUMENTS');
const compiler=resolve(root,'node_modules/typescript/bin/tsc');
if(!existsSync(compiler))throw Error('OFFLINE_TYPESCRIPT_REQUIRED; no download attempted');
const result=spawnSync(process.execPath,[compiler,'-p','tsconfig.web.json'],{cwd:root,stdio:'inherit'});
if(result.status!==0)process.exit(result.status||1);
for(const f of ['index.html','dreamflow.html','style.css','tokens.css','base.css','hallmark.css','chat-shell.css'])cpSync(resolve(root,'src/web',f),resolve(root,'dist/web',f));
const assets=['index.html','dreamflow.html','style.css','tokens.css','base.css','hallmark.css','chat-shell.css','chat-entry.js','chat-shell.js','chat-controller.js','chat-projection.js','chat-types.js','chat-stages.js','chat-work-status.js','app.js','dreamflow-app.js','contracts.js','dom.js','views.js','ui.js','local-api.js','preview.js','siwc-local.js','kimi-status-summary.js','native-readiness-summary.js','project-plan-view.js','flow-help-view.js','user-plan-view.js','setup-view.js','maintenance-view.js','lifecycle-view.js','managed-data-view.js','plan-history-view.js','research-view.js','flow-workspace-view.js','reviewer-view.js','plain-ui-error.js','frontend-guidance-view.js'];
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const sourceFiles=[];
function sources(dir){for(const n of readdirSync(dir).sort()){const p=resolve(dir,n),s=lstatSync(p);if(s.isSymbolicLink())throw Error('UI_SOURCE_LINK_DENIED');if(s.isDirectory())sources(p);else sourceFiles.push({path:p.slice(root.length+1).replaceAll('\\','/'),sha256:digest(p)});}}
sources(resolve(root,'src/web'));
sourceFiles.push({path:'src/shared/demo-tasks.ts',sha256:digest(resolve(root,'src/shared/demo-tasks.ts'))});
const dir=resolve(root,'docs/ui-upgrade/evidence/runs','local-build-'+Date.now());mkdirSync(dir,{recursive:true});
writeFileSync(resolve(dir,'local-build.json'),JSON.stringify({schema:'dream-maker.local-ui-build.v1',at:new Date().toISOString(),entry:'chat-entry.js',legacyEntry:'app.js',networkScope:'LOCAL_ONLY',publicReleaseCreated:false,sourceFiles,files:[...assets.map(path=>({path,sha256:digest(resolve(root,'dist/web',path))})),{path:'shared/demo-tasks.js',sha256:digest(resolve(root,'dist/shared/demo-tasks.js'))}]},null,2)+'\n',{flag:'wx'});
console.log('Built local UI assets; no public artifact or platform configuration generated.');
