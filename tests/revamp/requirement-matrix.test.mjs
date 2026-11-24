// Read-only traceability checks. Matrix coverage never grants product acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const matrix=JSON.parse(readFileSync(resolve('docs/revamp/REQUIREMENT_IMPLEMENTATION_MATRIX.json'),'utf8'));

test('requirement matrix keeps all 88 unique items partial and every target path current',()=>{
 assert.equal(matrix.schema,'dream-maker.requirement-implementation-matrix.v1');
 assert.equal(matrix.overall,'PARTIAL');
 assert.ok(Array.isArray(matrix.requirements));
 assert.equal(matrix.requirementCount,88);
 assert.equal(matrix.requirements.length,88);
 assert.equal(new Set(matrix.requirements.map(item=>item.id)).size,88);
 const stale=[];
 for(const item of matrix.requirements){
  assert.equal(item.acceptanceStatus,'NOT_VERIFIED',item.id);
  assert.ok(Array.isArray(item.targetFiles),item.id);
  for(const target of item.targetFiles){
   assert.equal(typeof target.path,'string',item.id);
   assert.equal(target.present,existsSync(resolve(target.path)),`${item.id}: ${target.path}`);
   if(!target.present)stale.push(`${item.id}:${target.path}`);
  }
 }
 assert.deepEqual(stale,[]);
});
