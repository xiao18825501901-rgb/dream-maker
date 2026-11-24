// Explicit filenames avoid dependence on shell wildcard expansion on Windows.
//
// The walk is recursive: it used to read the top level of tests/ only, so thirteen files under
// tests/siwc and tests/ui-upgrade were never part of `npm test` at all. A suite that silently skips whole
// directories is worse than a small one — a new test dropped into a subdirectory would have reported nothing
// and looked green.
import {readdirSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {availableParallelism,freemem} from 'node:os';
import {childEnv} from '../dist/server/security.js';
import {testHostCapacity} from './test-host-capacity.mjs';
import {selectTestFiles} from './select-test-files.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const tests=resolve(root,'tests');
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const path=resolve(dir,entry.name);
  if(entry.isDirectory())return walk(path);
  return entry.isFile()&&entry.name.endsWith('.test.mjs')?[path]:[];
});
const discovered=walk(tests).sort((a,b)=>relative(tests,a)<relative(tests,b)?-1:relative(tests,a)>relative(tests,b)?1:0);
const files=selectTestFiles(discovered,process.argv.slice(2),root);
if(!files.length)throw Error('NO_TEST_FILES');
const temporary=resolve(root,'.runtime/test-temp');
mkdirSync(temporary,{recursive:true});
// Real F-drive/SQLite parallel runs exposed transient low headroom and an HTTP polling deadline.
// Below3GiB use the owner-authorized1GiB floor and a single worker; above it keep
// the original parallel reservation. A test worker is not Native qualification.
const cpuSlots=availableParallelism(),freeMemoryMiB=Math.floor(freemem()/1048576);
const {workers,reservedMiB,perWorkerMiB}=testHostCapacity(cpuSlots,freeMemoryMiB);
console.log(JSON.stringify({check:'test-host-capacity',cpuSlots,freeMemoryMiB,workers,reservedMiB,perWorkerMiB,fileCount:files.length,scope:'TEST_POOL_ONLY_NOT_NATIVE_QUALIFICATION'}));
if(workers<1)throw Error(`TEST_HOST_CAPACITY_UNAVAILABLE:${freeMemoryMiB}:${reservedMiB+perWorkerMiB}`);
const result=spawnSync(process.execPath,['--test',`--test-concurrency=${workers}`,...files.map(file=>relative(root,file))],{cwd:root,stdio:'inherit',shell:false,env:childEnv({TEMP:temporary,TMP:temporary,TMPDIR:temporary})});
if(result.error){console.error(result.error.message);process.exit(1);}
process.exit(result.status??1);
