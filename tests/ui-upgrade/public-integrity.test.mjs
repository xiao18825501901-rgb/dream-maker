// Offline release-boundary tests, no platform writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { harness } from '../helpers.mjs';
import { PUBLIC_FILES, publicIntegrity } from '../../scripts/ui-upgrade/public-integrity.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
function fixture(t){
    const h=harness(t),dir=resolve(h.dir,'ui-release/public');mkdirSync(dir,{recursive:true});
    const files=PUBLIC_FILES.map(path=>{writeFileSync(resolve(dir,path),path);return{path,sha256:hash(path),bytes:Buffer.byteLength(path)};});
    mkdirSync(resolve(h.dir,'src/web'),{recursive:true});writeFileSync(resolve(h.dir,'src/web/app.ts'),'offline source');
    writeFileSync(resolve(h.dir,'ui-release/build-receipt.json'),JSON.stringify({files,sourceFiles:[{path:'src/web/app.ts',sha256:hash('offline source')}]}));
    return{h,dir};
}
test('release guard verifies precisely fifteen current files and rejects added private content',t=>{
    const f=fixture(t);assert.equal(publicIntegrity(f.h.dir).files.length,15);
    writeFileSync(resolve(f.dir,'local-api.js'),'private');
    assert.throws(()=>publicIntegrity(f.h.dir),/PUBLIC_ALLOWLIST_MISMATCH/);
});
test('release guard refuses byte changes and a source change after build',t=>{
    const f=fixture(t);writeFileSync(resolve(f.h.dir,'src/web/app.ts'),'changed source');
    assert.throws(()=>publicIntegrity(f.h.dir),/PUBLIC_SOURCE_CHANGED/);
    writeFileSync(resolve(f.h.dir,'src/web/app.ts'),'offline source');writeFileSync(resolve(f.dir,'ui.js'),'changed compiled bytes');
    assert.throws(()=>publicIntegrity(f.h.dir),/PUBLIC_HASH_MISMATCH/);
});
