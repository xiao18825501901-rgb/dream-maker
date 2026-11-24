// Refresh traceability provenance only. This script never promotes requirement
// acceptance and never substitutes a hash refresh for product verification.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../..',import.meta.url));
const matrixPath=resolve(root,'docs/revamp/REQUIREMENT_IMPLEMENTATION_MATRIX.json');
const git=(...args)=>execFileSync('git',args,{
  cwd:root,
  encoding:'utf8',
  windowsHide:true,
  maxBuffer:12_000_000,
});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const matrix=JSON.parse(readFileSync(matrixPath,'utf8'));

if(
  matrix.schema!=='dream-maker.requirement-implementation-matrix.v1'||
  matrix.overall!=='PARTIAL'||
  matrix.requirementCount!==88||
  !Array.isArray(matrix.requirements)||
  matrix.requirements.length!==88
)throw Error('REQUIREMENT_MATRIX_SHAPE_INVALID');

for(const item of matrix.requirements){
  if(item.acceptanceStatus!=='NOT_VERIFIED')
    throw Error('REQUIREMENT_ACCEPTANCE_MAY_NOT_BE_CHANGED_BY_METADATA_REFRESH');
  for(const target of item.targetFiles??[]){
    if(typeof target.path!=='string'||!target.path)
      throw Error('REQUIREMENT_TARGET_PATH_INVALID');
    const present=existsSync(resolve(root,target.path));
    if(target.present!==present)
      throw Error(`REQUIREMENT_TARGET_PRESENCE_DRIFT:${item.id}:${target.path}`);
    if(!present)
      throw Error(`REQUIREMENT_TARGET_MISSING:${item.id}:${target.path}`);
  }
}

const paths=[...new Set(
  git(
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'AGENTS.md',
    'package.json',
    'tsconfig.json',
    'tsconfig.web.json',
    'src',
    'dist',
    'migrations',
    'prompts',
    'scripts',
    'tests',
  ).trim().split(/\r?\n/).filter(Boolean),
)].sort();
const source=paths.map(path=>({
  path,
  sha256:sha(readFileSync(resolve(root,path))),
}));
const sourceHash=sha(JSON.stringify(source));

matrix.sourceHash=sourceHash;
matrix.head=git('rev-parse','HEAD').trim();
matrix.lastCheckedAt=new Date().toISOString();
writeFileSync(matrixPath,JSON.stringify(matrix,null,2)+'\n');

console.log(JSON.stringify({
  status:'PASS_METADATA_ONLY_REFRESH',
  matrix:matrixPath,
  sourceHash,
  sourceFiles:source.length,
  requirements:matrix.requirements.length,
  acceptanceStatusesChanged:0,
  lastCheckedAt:matrix.lastCheckedAt,
}));
