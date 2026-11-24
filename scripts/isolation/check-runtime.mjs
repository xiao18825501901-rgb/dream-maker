// Actual dedicated WSL execution, no models or fabricated native acceptance.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WslSandbox } from '../../dist/server/wsl-sandbox.js';
import { WslVerifier } from '../../dist/server/wsl-verifier.js';
import { hash } from '../../dist/server/security.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv[2]!=='--real-os')throw Error('EXPLICIT_REAL_OS_CHECK_REQUIRED');
const directory=resolve(root,'.runtime/isolation-checks');mkdirSync(directory,{recursive:true});
const data=mkdtempSync(resolve(directory,'native-')),workspace=resolve(data,'workspace');mkdirSync(workspace);
const code=`import sys,os,json
from helper import identity
assert os.getuid()==34271
assert 'DM_CONTROLLER_CANARY' not in os.environ
assert identity()=='local_module'
print(json.dumps({'args':sys.argv[1:],'stdin':sys.stdin.read()},ensure_ascii=False))
`;
writeFileSync(resolve(workspace,'main.py'),code);
writeFileSync(resolve(workspace,'helper.py'),"def identity():return 'local_module'\n");
process.env.DM_CONTROLLER_CANARY='SYNTHETIC_CONTROLLER_ONLY';
const sandbox=new WslSandbox(root),checks=[];
try{
    const result=await sandbox.run(workspace,{runtime:'python',entry:'main.py',args:[' space '],stdin:' input\n'},{wallSeconds:5});
    const value=JSON.parse(result.stdout);
    if(result.status!=='EXECUTED'||result.exitCode!==0||value.args[0]!==' space '||value.stdin!==' input\n')throw Error('RAW_INPUT_OR_EXECUTION_FAILED');
    checks.push({name:'real Python isolated execution and exact input',result:'PASS',kernel:result});
    writeFileSync(resolve(workspace,'main.mjs'),"process.stdout.write('42\\n');\n");
    const specHash=hash('SYNTHETIC_CLI_SPEC_NOT_LIVE_MODEL'),plan={schema:'dream-maker.cli-verifier.v1',specHash,cases:[{id:'A1',requirementIds:['R1'],runtime:'node',entry:'main.mjs',args:[],stdin:'',expectedExitCode:0,expectedStdout:'42\n'}]};
    const planRoot=resolve(data,'trusted-oracle');mkdirSync(planRoot);const bytes=Buffer.from(JSON.stringify(plan));writeFileSync(resolve(planRoot,'plan.json'),bytes);
    const verifier=new WslVerifier(root,planRoot,()=>({relativePath:'plan.json',sha256:hash(bytes)}));
    const input={role:'executor',workspace,prompt:JSON.stringify({spec:{hash:specHash,requirements:[{id:'R1'}]}}),specHash,runId:'OS_TEST_ONLY',signal:new AbortController().signal};
    const output=await verifier.verify(input,e=>checks.push({name:'controller case evidence',result:'OBSERVED',event:e}));
    if(output.exitCode!==0)throw Error('TRUSTED_ORACLE_DID_NOT_PASS');
    checks.push({name:'real Node execution plus outside-process exact-output oracle',result:'PASS',output});
    writeFileSync(resolve(workspace,'main.mjs'),"console.log('PASS');\n");
    const failure=await verifier.verify(input,()=>{});
    if(failure.exitCode===0)throw Error('GENERATED_PASS_SUMMARY_BYPASSED_ORACLE');
    checks.push({name:'exit0 plus generated PASS cannot bypass controller oracle',result:'PASS',output:failure});
}catch(error){checks.push({name:'real WSL runtime sequence',result:'FAIL',code:error.code??error.message,diagnostic:error.message});process.exitCode=1;}
finally{
    delete process.env.DM_CONTROLLER_CANARY;
    const evidence=resolve(root,'docs/native-isolation/evidence');mkdirSync(evidence,{recursive:true});
    const output=resolve(evidence,'runtime-'+Date.now()+'.json');
    writeFileSync(output,JSON.stringify({schema:'dream-maker.wsl-runtime-check.v1',at:new Date().toISOString(),environment:'DreamMaker-Acceptance-20261011',evidenceClass:'REAL_OS_EXECUTION_NOT_LIVE_AGENT',modelCalls:0,checks},null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({checks:checks.map(({name,result,code,diagnostic})=>({name,result,code,diagnostic})),evidence:output}));
}
