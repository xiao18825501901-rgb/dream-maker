// Read-only release gate. The manifest hash must be supplied by the enclosing release build.
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {qualifyDistributionEvidence} from '../../dist/server/release/component-inventory.mjs';

function arg(name,fallback){
  const index=process.argv.indexOf(name);
  if(index<0)return fallback;
  if(index+1>=process.argv.length)throw new Error(`RELEASE_EVIDENCE_ARGUMENT_MISSING:${name}`);
  return process.argv[index+1];
}

const suite=resolve(process.env.DREAMMAKER_SUITE_ROOT??'F:\\DreamMakerSuite');
const root=resolve(arg('--root','.'));
const manifestPath=arg('--manifest',null);
const expectedManifestSha256=arg('--manifest-sha256',null);
const variant=arg('--variant',null);
const output=resolve(arg('--output',`${suite}\\evidence\\M85\\component-evidence-gate-${Date.now()}.json`));
if(existsSync(output))throw new Error('RELEASE_EVIDENCE_OUTPUT_EXISTS');

const result=qualifyDistributionEvidence({root,manifestPath,expectedManifestSha256,variant});
const report={
  schema:'dream-maker.release-component-gate-run.v1',
  at:new Date().toISOString(),
  status:result.completeCore?'PASS_VERIFIED_COMPONENT_EVIDENCE':'BLOCKED_COMPONENT_EVIDENCE',
  root,
  manifestPath,
  expectedManifestSha256,
  variant,
  result,
  installerBuilt:false,
  packageScriptsExecuted:false,
  modelCalls:0,
  credentialsRead:false
};
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',flush:true});
console.log(JSON.stringify({output,status:report.status,completeCore:result.completeCore,problems:result.problems,modelsCalled:0}));
process.exitCode=result.completeCore?0:1;
