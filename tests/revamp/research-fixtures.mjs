import {sha256,digest} from '../../dist/server/research/common.mjs';
export const ACTOR={type:'user',id:'fixture-owner'};
export const NOW=Date.parse('2026-11-01T00:00:00Z');
export const verifyEvidence=(r,scope)=>r?.fixture===true&&r.kind===scope.kind&&Object.entries(scope).every(([k,v])=>k==='kind'||r[k]===v);
export const receipt=(kind,scope={})=>({fixture:true,kind,...scope});
export function planBody(overrides={}){
 return {goal:'制作一个可本地使用的笔记工具',requirements:[{id:'R001',text:'可创建并保存笔记',origin:'USER',sources:['description']}],acceptance:[{id:'A001',check:'保存后重新打开，内容仍在',requirementIds:['R001']}],architecture:{type:'local-web'},delivery:{type:'local-app',standalone:true},milestones:['完成核心功能','检查与交付'],assumptions:[],unknowns:[],outOfScope:[],research:{status:'UNAVAILABLE',sourceRefs:[],explanation:'Synthetic test has no public network'},reuse:{mode:'IMPLEMENT_ORIGINAL',selected:[]},...overrides};
}
export function snapshot(overrides={}){
 const core={platform:'github',namespace:'fixture-lab/notes',webUrl:'https://github.com/fixture-lab/notes',sourceId:'100',commit:'a'.repeat(40),discoveredLicenseHint:'MIT',archived:false,disabled:false,description:'SYNTHETIC: not a real upstream project',files:[],failures:[],retrievedAt:new Date(NOW).toISOString(),evidenceLevel:'PINNED_TEXT_ONLY_NOT_EXECUTED',...overrides};
 if(!overrides.files)core.files=['README.md','LICENSE'].map(path=>{const content=path==='LICENSE'?'SYNTHETIC LICENSE FIXTURE — not a real grant':'SYNTHETIC notes implementation documentation';return {path,content,contentSha256:sha256(content),bytes:Buffer.byteLength(content),url:`${core.webUrl}/blob/${core.commit}/${path}`,ref:core.commit,retrievedAt:core.retrievedAt,trust:'UNTRUSTED_REPOSITORY_DATA'};});
 return {...core,snapshotHash:digest(core)};
}
export function context(){return {requirementIds:['R001'],intentHash:digest('synthetic-intent'),distribution:'local-personal'};}
export function assessment(s=snapshot(),c=context()){
 return {id:'fixture-assessment',snapshotHash:s.snapshotHash,intentHash:c.intentHash,distribution:c.distribution,expiresAt:'2026-11-02T00:00:00Z',sourceIdentity:'VERIFIED',license:{status:'COMPATIBLE_WITH_INTENDED_USE',evidence:[{path:'LICENSE',contentSha256:s.files.find(f=>f.path==='LICENSE').contentSha256}],obligations:['retain required notices in this synthetic example'],dependenciesReviewed:true,assetsReviewed:true},security:'REVIEWED_NO_UNRESOLVED_BLOCKER',runtime:'COMPATIBLE',installation:'REVIEWED_NOT_EXECUTED',ownership:'NO_CREDENTIAL_OR_PRIVATE_DATA_DEPENDENCY',coverage:[{requirementId:'R001',status:'PRESENT',explanation:'fixture documentation claim',evidencePaths:['README.md']}],mode:'REUSE_COMPONENTS',filesInScope:['README.md'],scores:{requirementFit:0.8,changeCost:0.7,runtimeFit:1,validationQuality:0.6,maintenance:0.8,dependencyComplexity:0.8}};
}
export function task(id,extra={}){return {id,projectId:'p1',flowId:'f1',workspaceKey:'w1',kind:'MODEL',dependsOn:[],reads:[],writes:[`${id}.txt`],exclusiveResources:[],demand:{cpu:1,memoryMiB:256,externalModelSlots:1},...extra};}
