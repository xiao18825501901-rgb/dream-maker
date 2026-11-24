// Offline model boundary, real controlled file tools. Never a product Live receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {harness} from '../helpers.mjs';
import {hash} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
const module=await import('../../dist/server/flow/dsh-engineering.js');
const signal=new AbortController().signal;
async function rig(t,beforeTools){const h=harness(t),workspace=join(h.dir,'engineering');mkdirSync(workspace);const base='F:/DreamMakerSuite/runtime/archon-controller-dm-8896a7db4062/dist',path=base+'/provider/file-tools.js',io=base+'/core/io.js';
 const binding={modulePath:path,dependencies:[{path,sha256:hash(readFileSync(path))},{path:io,sha256:hash(readFileSync(io))}],readPaths:[],writePaths:[]};let current=true;
 const input={acceptanceId:'dsh_acceptance_offline',workspace,contractHash:module.dshEngineeringContractHash,configurationHash:'a'.repeat(64),signal};
 const records=[],record=(kind,data)=>{const id=h.store.record(kind,null,null,{acceptanceId:input.acceptanceId,...data});records.push({id,kind,data});return id;};
 record('EngineeringAcceptanceIntent',{workspace,contractHash:input.contractHash,configurationHash:input.configurationHash,initialSourceHash:treeHash(workspace)});beforeTools?.(workspace);
 const tools=await module.createDshEngineeringTools(input,binding,{run:async()=>{throw Error('OFFLINE_KERNEL_UNKNOWN');}},()=>{if(!current)throw Object.assign(Error('STALE'),{code:'ENGINEERING_ACCEPTANCE_STALE'});},record,()=>records);
 return{h,input,tools,records,record,setCurrent:v=>current=v};}
test('explicit engineering controller writes only its two files and cannot act as another role',async t=>{
 const f=await rig(t);
 await assert.rejects(f.tools.dispatch('reviewer','desk_write',{path:'main.mjs',content:'x',expected_sha:''},signal),{code:'EXECUTOR_ROLE_REQUIRED'});
 await assert.rejects(f.tools.dispatch('executor','desk_write',{path:'../escape.mjs',content:'x',expected_sha:''},signal),{code:'ENGINEERING_TOOL_PATH_DENIED'});
 await f.tools.dispatch('executor','desk_write',{path:'main.mjs',content:'console.log(1);\n',expected_sha:''},signal);
 const read=await f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal);
 await f.tools.dispatch('executor','desk_edit',{path:'main.mjs',old_text:'(1)',new_text:'(2)',expected_sha:read.sha256},signal);
 assert.equal(readFileSync(join(f.input.workspace,'main.mjs'),'utf8'),'console.log(2);\n');assert.equal(f.h.store.projects().length,0);assert.equal(f.h.store.runs().length,0);
});
test('engineering desk_edit restores redundant JSON quote escapes without weakening uniqueness',async t=>{
 const f=await rig(t),line='错误：不支持的参数：["--file"]。\n';
 await f.tools.dispatch('executor','desk_write',{path:'README.md',content:line,expected_sha:''},signal);
 const read=await f.tools.dispatch('executor','desk_read',{path:'README.md'},signal);
 await f.tools.dispatch('executor','desk_edit',{path:'README.md',old_text:'错误：不支持的参数：[\\"--file\\"]。',new_text:'错误：不支持的参数：\\"--file\\" \\"records.json\\"。',expected_sha:read.sha256},signal);
 assert.equal(readFileSync(join(f.input.workspace,'README.md'),'utf8'),'错误：不支持的参数："--file" "records.json"。\n');
 const g=await rig(t);
 await g.tools.dispatch('executor','desk_write',{path:'README.md',content:line+line,expected_sha:''},signal);
 const duplicate=await g.tools.dispatch('executor','desk_read',{path:'README.md'},signal);
 await assert.rejects(g.tools.dispatch('executor','desk_edit',{path:'README.md',old_text:'错误：不支持的参数：[\\"--file\\"]。',new_text:'changed',expected_sha:duplicate.sha256},signal),{code:'STALE_OR_AMBIGUOUS_EDIT'});
 assert.equal(readFileSync(join(g.input.workspace,'README.md'),'utf8'),line+line);
});
test('stale authority, changed source, and eight tool calls stop before another effect',async t=>{
 const f=await rig(t);await f.tools.dispatch('executor','desk_write',{path:'main.mjs',content:'x',expected_sha:''},signal);
 for(let i=1;i<8;i++)await f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal);
 await assert.rejects(f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal),{code:'ENGINEERING_TOOL_LIMIT'});
 const g=await rig(t);g.setCurrent(false);await assert.rejects(g.tools.dispatch('executor','desk_write',{path:'main.mjs',content:'x',expected_sha:''},signal),{code:'ENGINEERING_ACCEPTANCE_STALE'});
 assert.equal(g.records.filter(r=>r.kind==='EngineeringToolIntent').length,0);
 const j=await rig(t);writeFileSync(join(j.input.workspace,'README.md'),'outside change');await assert.rejects(j.tools.dispatch('executor','desk_read',{path:'README.md'},signal),{code:'EXTERNAL_WORKSPACE_CHANGE'});
});
test('preexisting source after the durable empty intent is rejected before the first tool',async t=>{
 await assert.rejects(rig(t,workspace=>writeFileSync(join(workspace,'main.mjs'),'// external preseed')),{code:'EXTERNAL_WORKSPACE_CHANGE'});
});
test('external completion cannot replace the acknowledged DSH source or supply an unwritten main file',async t=>{
 const f=await rig(t);await f.tools.dispatch('executor','desk_write',{path:'README.md',content:'OFFLINE',expected_sha:''},signal);
 writeFileSync(join(f.input.workspace,'main.mjs'),'// external');assert.throws(()=>module.dshEngineeringArtifacts(f.input,f.records),{code:'ENGINEERING_TOOL_EXECUTION_UNVERIFIED'});
});
test('both artifact bytes are backed by successful tool writes and a later outside edit invalidates them',async t=>{
 const f=await rig(t);for(const path of ['main.mjs','README.md'])await f.tools.dispatch('executor','desk_write',{path,content:'OFFLINE_'+path,expected_sha:''},signal);
 assert.equal(module.dshEngineeringArtifacts(f.input,f.records).sourceHash,treeHash(f.input.workspace));
 writeFileSync(join(f.input.workspace,'main.mjs'),'outside');assert.throws(()=>module.dshEngineeringArtifacts(f.input,f.records),{code:'ENGINEERING_TOOL_EXECUTION_UNVERIFIED'});
});
test('a fresh allowed file returns an explicit missing-file creation token instead of an opaque tool failure',async t=>{
 const f=await rig(t),read=await f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal);
 assert.deepEqual(read,{exists:false,content:'',sha256:''});
 await f.tools.dispatch('executor','desk_write',{path:'main.mjs',content:'// OFFLINE_CREATED',expected_sha:read.sha256},signal);
 assert.equal(readFileSync(join(f.input.workspace,'main.mjs'),'utf8'),'// OFFLINE_CREATED');
});
test('unproven generated execution freezes further tools and keeps an unknown journal',async t=>{
 const f=await rig(t);await f.tools.dispatch('executor','desk_write',{path:'main.mjs',content:'console.log(1);',expected_sha:''},signal);
 await assert.rejects(f.tools.dispatch('executor','desk_run',{runtime:'node',entry:'main.mjs',args:[],stdin:''},signal),/OFFLINE_KERNEL_UNKNOWN/);
 assert.ok(f.records.some(r=>r.kind==='EngineeringToolResult'&&r.data.status==='UNKNOWN_EFFECT'));
 await assert.rejects(f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal),{code:'TOOL_RECOVERY_REQUIRED'});
});
