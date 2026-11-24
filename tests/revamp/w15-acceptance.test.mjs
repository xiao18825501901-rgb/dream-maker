// 隔离库 W15 写回验收：不碰实例库、不碰用户项目。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ManagedDatasets} from '../../dist/server/managed-data.js';
import {hash} from '../../dist/server/security.js';
import {harness,ready,root} from '../helpers.mjs';

const actor='local-session:'+'a'.repeat(64);
const task=(title)=>[{id:'task1',title,done:false}];
const op=(name)=>hash('W15_ACCEPTANCE_'+name);

test('W15 acceptance: a real keeper write-back creates the first managed_dataset rows', async (t) => {
  const h=harness(t,0);
  const {p,s}=await ready(h);
  const created=h.engine.create(p.id,s.hash,true);
  await h.engine.settled(created.id);
  const run=h.store.run(created.id);
  const data=new ManagedDatasets(h.store,root);
  const before=h.store.db.prepare('SELECT COUNT(*) AS n FROM managed_dataset_versions').get().n;
  const view=data.writePreview(run.id,run.treeHash,task('W15 acceptance payload '+Date.now()),0,op('first'),actor);
  const after=h.store.db.prepare('SELECT COUNT(*) AS n FROM managed_dataset_versions').get().n;
  const heads=h.store.db.prepare('SELECT COUNT(*) AS n FROM managed_dataset_heads').get().n;
  const ops=h.store.db.prepare('SELECT COUNT(*) AS n FROM managed_dataset_operations').get().n;
  const payload=h.store.db.prepare('SELECT data_json FROM managed_dataset_versions ORDER BY rowid DESC LIMIT 1').get();
  console.log('W15_RESULT revisions_before='+before+' revisions_after='+after+' heads='+heads+' operations='+ops+' revision='+view.revision);
  assert.equal(after,before+1,'a real version row must be written');
  assert.ok(heads>=1,'a head row must exist');
  assert.ok(ops>=1,'an operation row must exist');
  assert.equal(view.revision,1);
  assert.ok(String(payload.data_json).includes('W15 acceptance payload'),'the payload must be persisted');
  writeFileSync(resolve(root,'..','W15_ACCEPTANCE_RESULT.json'),JSON.stringify({
    schema:'dream-maker.w15-acceptance.v1',
    projectId:p.id, runId:run.id, treeHash:run.treeHash,
    revisions:{before,after}, heads, operations:ops, revision:view.revision
  },null,2));
});
