// Static assessment authority; synthetic repository data never proves a real source safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceAssessments } from '../../dist/server/research/source-assessment.js';
import { evaluateReuse } from '../../dist/server/research/reuse-policy.mjs';
import { harness } from '../helpers.mjs';
import { snapshot,context,assessment } from './research-fixtures.mjs';
test('fixed README/license inspection yields a durable scoped negative assessment, not reuse permission',t=>{
 const h=harness(t),p=h.interviews.create('source test','source facts','demo');
 const service=new SourceAssessments(h.store),s=snapshot(),c=context(),out=service.inspect(p.id,s,c);
 assert.equal(service.verify(out),true);
 assert.equal(new SourceAssessments(h.store).verify(out),true,'restart reads the same controller record');
 assert.equal(out.license.status,'UNKNOWN');
 assert.equal(out.security,'REVIEW_INCOMPLETE');
 const result=evaluateReuse(s,out,c,{verifyAssessment:v=>service.verify(v)});
 assert.equal(result.eligible,false);
 assert.ok(result.reasons.includes('LICENSE_NOT_CLEARED'));
 assert.ok(result.reasons.includes('SECURITY_REVIEW_REQUIRED'));
 assert.equal(out.inspection.executedSourceCode,false);
 assert.equal(out.inspection.files.length,2);
 assert.equal(service.inspect(p.id,s,c).id,out.id,'identical inspections are reused');
});
test('model-written positive claims or edits to a controller assessment cannot qualify',t=>{
 const h=harness(t),p=h.interviews.create('source test','source facts','demo'),service=new SourceAssessments(h.store),s=snapshot(),c=context();
 assert.equal(service.verify(assessment(s,c)),false);
 const out=service.inspect(p.id,s,c);
 assert.equal(service.verify({...out,security:'REVIEWED_NO_UNRESOLVED_BLOCKER'}),false);
 assert.equal(service.verify({...out,intentHash:'f'.repeat(64)}),false);
 assert.equal(service.verify({...out,expiresAt:'2099-01-01T00:00:00Z'}),false);
 const corrupt=snapshot();corrupt.files[0].content+='altered';
 assert.throws(()=>service.inspect(p.id,corrupt,c),{code:'REPOSITORY_SNAPSHOT_CHANGED'});
});
