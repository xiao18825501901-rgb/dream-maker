// Current core contract preservation, not Live/model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticRows, semanticPayload } from '../../dist/web/contracts.js';
import { shell } from '../../dist/web/views.js';
import { harness, ready } from '../helpers.mjs';

test('UI preserves existing joint acceptance items and allocates noncolliding per-requirement IDs',async t=>{
    const h=harness(t), project=h.interviews.create('Joint criteria','First original requirement','demo');
    await h.interviews.next(project.id);
    const question=h.store.project(project.id).questions[0];
    h.interviews.answer(project.id,question.id,'Second original requirement');
    await h.interviews.finish(project.id,'',false);
    const s=h.store.spec(h.store.project(project.id).specId);
    s.acceptanceItems=[{id:'A1',requirementIds:s.requirements.map(r=>r.id),criterion:'Existing joint criterion',method:'manual',source:'USER_CONFIRMED',evidenceStatus:'NOT_RUN'}];
    const rows=semanticRows(s);
    assert.equal(rows.some(row=>row.item.id==='A1'),false);
    assert.equal(new Set(rows.map(row=>row.item.id)).size,rows.length);
    const original=structuredClone(s);
    const payload=semanticPayload(s,key=>key.startsWith('criterion-')?'Manual check':key.startsWith('priority-')?'must':'functional',true);
    assert.equal(payload.specHash,s.hash); assert.equal(payload.confirmed,true);
    assert.equal(payload.acceptanceItems[0].id,'A1');
    assert.equal(payload.acceptanceItems[0].criterion,'Existing joint criterion');
    assert.equal(payload.requirements.every(r=>r.kind==='functional'),true);
    assert.deepEqual(s,original);
});
test('classification controls remain local-only and cannot grant build approval',async t=>{
    const h=harness(t), {p,s}=await ready(h);
    const view={mode:'local',screen:'project',projects:[p],snapshot:{project:p,spec:s,runs:[],records:[]},settings:null,tab:'spec',busy:false,error:'',events:[],connection:'closed',railClosed:false,fileName:'',fileText:'',files:[],previewUrl:'',previewScope:'',diagnostics:'',specSearch:'',logLimit:40,draft:()=>'',hasDraft:()=>false};
    const local=shell(view), publicHtml=shell({...view,mode:'public-demo'});
    assert.match(local,/id="semantics-form"/);
    assert.match(local,/name="semanticConsent"[^>]*required/);
    assert.match(local,/name="buildConsent"/);
    assert.doesNotMatch(publicHtml,/id="semantics-form"/);
});
