// Read-only Windows component discovery. No package scripts, auth, model calls, installs or bundling.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {observeExpectedPackage,observeComponentFile,projectWslConfiguration,readComponentJson} from '../../dist/server/release/local-component.js';
import {qualifyDistribution,qualifyDistributionEvidence,REQUIRED_CORE_COMPONENTS} from '../../dist/server/release/component-inventory.mjs';
import {hasSecret,registerCredentialEnv} from '../../dist/server/security.js';
if(process.platform!=='win32')throw Error('WINDOWS_COMPONENT_INVENTORY_ONLY');
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const json=path=>readComponentJson(path);
const c=json(resolve(root,'config/local.json')),op=json(resolve(root,'config/native-owner.local.json'));
for(const section of [c.planner1,c.dsh,c.independent])if(typeof section?.keyEnv==='string')registerCredentialEnv(section.keyEnv);
if(resolve(op.scopeRoot)!==root)throw Error('OPERATOR_SCOPE_MISMATCH');
const template=json(op.template.path);if(observeComponentFile(op.template.path,128000).sha256!==op.template.sha256)throw Error('OPERATOR_TEMPLATE_CHANGED');
const codexEntry=c.codex?.args?.[0],dshEntry=template.dshBin,archonEntry=template.hostModule;
if(![codexEntry,dshEntry,archonEntry].every(value=>typeof value==='string'&&value.length>0))throw Error('COMPONENT_ENTRY_NOT_CONFIGURED');
const codex=observeExpectedPackage(codexEntry,'@openai/codex'),dsh=observeExpectedPackage(dshEntry,'@deepseek-ai/dsh'),archon=observeExpectedPackage(archonEntry,'archon-astra-dsh-localdesk-control');
const devDshEntry=resolve(process.env.APPDATA??'MISSING_APPDATA','npm/node_modules/@deepseek-ai/dsh/lib/bin.js'),developmentDsh=observeExpectedPackage(devDshEntry,'@deepseek-ai/dsh');
const node={version:process.version,entry:observeComponentFile(process.execPath),licenseFiles:['LICENSE','LICENSE.txt','NOTICE','COPYING'].map(name=>observeComponentFile(resolve(dirname(process.execPath),name),1000000)),bundled:false,redistributionReviewed:false,cleanMachineRunVerified:false};
const sourceFiles=['dist/server/main.js','dist/server/dreamflow-main.js','dist/server/engine.js','dist/server/providers/kimi.js','dist/web/index.html','dist/web/dreamflow.html'].map(path=>observeComponentFile(resolve(root,path),2000000));
const components=REQUIRED_CORE_COMPONENTS.map(id=>({id,bundled:false,redistributionReviewed:false,cleanMachineRunVerified:false,measuredBytes:0}));
const evidenceRoot=process.env.DM_COMPONENT_EVIDENCE_ROOT?resolve(process.env.DM_COMPONENT_EVIDENCE_ROOT):null;
const evidenceManifestPath=process.env.DM_COMPONENT_EVIDENCE_MANIFEST??null;
const evidenceManifestSha256=process.env.DM_COMPONENT_EVIDENCE_SHA256??null;
const componentEvidence=evidenceRoot&&evidenceManifestPath
 ?qualifyDistributionEvidence({root:evidenceRoot,manifestPath:evidenceManifestPath,expectedManifestSha256:evidenceManifestSha256??undefined,variant:'PORTABLE'})
 :{scope:'VERIFIED_COMPONENT_EVIDENCE_RELEASE_GATE',completeCore:false,evidenceVerified:false,problems:[{component:'*',code:'EVIDENCE_MANIFEST_UNPINNED'}],components:[],accountReady:false,modelsBundled:false,measuredBytes:0,manifestSha256:null};
const report={schema:'dream-maker.windows-components.v1',at:new Date().toISOString(),scope:'LOCAL_METADATA_INVENTORY_NOT_INSTALLER_OR_ROLE_PROOF',head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),
 node,codex,dsh,archon,developmentDsh:{...developmentDsh,authorizedDevelopmentEntry:'npx @deepseek-ai/dsh web',usage:'DEVELOPMENT_COORDINATION_ONLY_NOT_PRODUCT_EXECUTOR'},
 productionBindings:{codexTransport:['stdio','wsl'].includes(c.codex.transport)?c.codex.transport:'UNKNOWN',wsl:c.codex.transport==='wsl'?projectWslConfiguration(c.codex):null,executorAdapter:observeComponentFile(c.dsh.modulePath,2000000),planner1Provider:['kimi','openai','deepseek','siwc'].includes(c.planner1.provider)?c.planner1.provider:'UNKNOWN',kimiServicePackage:'NOT_DISCOVERED_FROM_CURRENT_CONFIG_NO_TOKEN_FILE_READ'},
 controllerSource:sourceFiles,components,componentEvidence,installer:qualifyDistribution({components,variant:'INSTALLER'}),portable:qualifyDistribution({components,variant:'PORTABLE'}),
 observedBytesScope:'SELECTED_INSTALLED_FILES_ONLY_NOT_DIRECTORY_OR_DISTRIBUTION_SIZE',distributionBytes:null,downloads:0,installs:0,modelCalls:0,credentialFilesOpened:false,credentialsReturned:false,packageScriptsExecuted:false,globalConfigurationChanged:false,nativeRoles:'NOT_RUN',cleanWindows:'NOT_RUN',overall:'PARTIAL'};
const output=resolve(root,'docs/revamp/evidence/W16/inventory-'+new Date().toISOString().replace(/[^0-9T]/g,''));mkdirSync(output,{recursive:true});
const body=JSON.stringify(report,null,2)+'\n';if(hasSecret(body))throw Error('SENSITIVE_COMPONENT_REPORT_DENIED');
writeFileSync(resolve(output,'inventory.json'),body,{flag:'wx'});
console.log(JSON.stringify({output,scope:report.scope,node:node.version,codex:codex.version,productionDsh:dsh.version,developmentDsh:developmentDsh.version,archonDeclaredLicense:archon.declaredLicense,installerComplete:false,portableComplete:false,modelsCalled:0}));
