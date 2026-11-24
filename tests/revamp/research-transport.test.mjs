import test from 'node:test';
import assert from 'node:assert/strict';
import { researchTarget, createAnonymousResearchTransport } from '../../dist/server/research/transport.js';
import { clashResearchFetch, controlledResearchInit } from '../../dist/server/clash-transport.js';
test('repository transport permits only approved read-only API paths, never model/auth or arbitrary sites',()=>{
 assert.equal(researchTarget('https://api.github.com/repos/a/b/contents/LICENSE?ref='+'a'.repeat(40)).hostname,'api.github.com');
 assert.equal(researchTarget('https://gitlab.com/api/v4/projects/a%2Fb/repository/commits?per_page=1&ref_name=main').hostname,'gitlab.com');
 for(const url of ['http://api.github.com/repos/a/b','https://api.github.com/graphql','https://gitlab.com/users/sign_in','https://api.openai.com/v1/models','https://api.github.com/repos/a/b?access_token=x','https://user:pass@api.github.com/repos/a/b','https://127.0.0.1/repos/a/b'])assert.throws(()=>researchTarget(url));
 assert.throws(()=>researchTarget('https://api.github.com/repos/a/b','POST'));
});
test('anonymous source transport refuses model credentials before DNS or network activity',async()=>{
 let lookups=0;const transport=createAnonymousResearchTransport({resolve:async()=>{lookups++;return[];}});
 await assert.rejects(transport('https://api.github.com/repos/a/b',{headers:{authorization:'Bearer SYNTHETIC_NOT_SECRET'}}),{code:'RESEARCH_CREDENTIALS_DENIED'});
 assert.equal(lookups,0);
});
test('DNS identity is checked for every address; loopback, private and metadata addresses stop before connecting',async()=>{
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','100.64.0.1','::1','fc00::1','2001:db8::1']){
  const transport=createAnonymousResearchTransport({resolve:async()=>[{address,family:address.includes(':')?6:4}]});
  await assert.rejects(transport('https://api.github.com/repos/a/b',{}),{code:'RESEARCH_DNS_NOT_PUBLIC'});
 }
 const transport=createAnonymousResearchTransport({resolve:async()=>[{address:'140.82.113.5',family:4},{address:'127.0.0.1',family:4}]});
 await assert.rejects(transport('https://api.github.com/repos/a/b',{}),{code:'RESEARCH_DNS_NOT_PUBLIC'});
});
test('CFW research transport keeps the anonymous read-only policy before opening any proxy connection',async()=>{
 const input={proxyUrl:'http://127.0.0.1:1/',expectedNode:'offline-node',controller:{traceConnection:async()=>{throw new Error('must not connect');}}};
 await assert.rejects(clashResearchFetch(input,'https://api.github.com/repos/a/b',{
  headers:{authorization:'Bearer SYNTHETIC_NOT_SECRET'}
 }),{code:'RESEARCH_CREDENTIALS_DENIED'});
 await assert.rejects(clashResearchFetch(input,'https://api.openai.com/v1/models',{}),{code:'RESEARCH_TARGET_DENIED'});
 await assert.rejects(clashResearchFetch(input,'https://api.github.com/repos/a/b',{method:'POST'}),{code:'RESEARCH_TARGET_DENIED'});
});
test('CFW research transport supplies the bounded anonymous user agent without overriding an explicit one',()=>{
 const injected=new Headers(controlledResearchInit({
  method:'GET',
  headers:{accept:'application/json','x-github-api-version':'2022-11-28'}
 }).headers);
 assert.equal(injected.get('user-agent'),'DreamMaker-Research/0.1');
 assert.equal(injected.get('accept'),'application/json');
 assert.equal(injected.get('x-github-api-version'),'2022-11-28');
 const preserved=new Headers(controlledResearchInit({
  headers:{'user-agent':'CallerResearch/1.0'}
 }).headers);
 assert.equal(preserved.get('user-agent'),'CallerResearch/1.0');
});
