// Local filesystem failure only. No credentials, model calls or formal config writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Settings,defaults} from '../../dist/server/config.js';
import {harness} from '../helpers.mjs';

test('a failed atomic config replacement leaves every setting and previous file unchanged',t=>{
 const h=harness(t),file=join(h.dir,'config.json');writeFileSync(file,JSON.stringify(defaults));const settings=new Settings(file);
 const before=structuredClone(settings.value),bytes=readFileSync(file),denied=join(h.dir,'replacement-denied');mkdirSync(denied);settings.path=denied;
 for(const update of [
  ()=>settings.updateUI({codexModel:'MUST_NOT_BECOME_ACTIVE'}),
  ()=>settings.attestSiwcNoncommercial(),()=>settings.selectSiwcProfile('MUST_NOT_BECOME_ACTIVE'),
  ()=>settings.selectPlanner1({provider:'openai',authentication:'api_key',model:'MUST_NOT_BECOME_ACTIVE',confirmed:true})
 ]){assert.throws(update);assert.deepEqual(settings.value,before);assert.deepEqual(readFileSync(file),bytes);}
});
