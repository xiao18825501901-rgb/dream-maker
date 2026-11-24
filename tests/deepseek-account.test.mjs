// OFFLINE URL/method guard tests. No account or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedJsonTarget,jsonFetch} from '../dist/server/security.js';
import {summarizeAccount} from '../scripts/probe-deepseek-account.mjs';
const endpoint='https://api.deepseek.com/user/balance';
test('authorized official account target is GET-only without widening model routes',()=>{
 assert.equal(allowedJsonTarget(endpoint,'GET').href,endpoint);
 for(const method of ['POST','PUT','DELETE','PATCH','HEAD'])assert.throws(()=>allowedJsonTarget(endpoint,method),{code:'NETWORK_TARGET_DENIED'});
 assert.throws(()=>allowedJsonTarget('https://api.deepseek.com/user/top_up','GET'),{code:'NETWORK_TARGET_DENIED'});
});
test('account read rejects query, credentials, noncanonical route and foreign hosts',()=>{
 for(const url of [endpoint+'?x=1',endpoint+'#x',endpoint+'/',endpoint.replace('https:','http:'),endpoint.replace('api.deepseek.com','evil.example'),endpoint.replace('api.deepseek.com','user@api.deepseek.com')])
  assert.throws(()=>allowedJsonTarget(url,'GET'),{code:'NETWORK_TARGET_DENIED'});
});
test('account GET with body is refused before any network transport',async()=>{
 await assert.rejects(jsonFetch(endpoint,{method:'GET',body:'UNAUTHORIZED_BODY'}),{code:'NETWORK_TARGET_DENIED'});
});
test('account summary keeps decimal funds and exact currencies but drops unexpected data',()=>{
 assert.deepEqual(summarizeAccount({is_available:true,balance_infos:[{currency:'CNY',total_balance:'12.34567890',granted_balance:'2.00',topped_up_balance:'10.34567890',token:'SYNTHETIC_UNEXPECTED_TOKEN'}],account_id:'SYNTHETIC_ACCOUNT'}),
  {isAvailable:true,balances:[{currency:'CNY',totalBalance:'12.34567890',grantedBalance:'2.00',toppedUpBalance:'10.34567890'}],cnyMicros:'12345678'});
});
test('USD is not silently converted and malformed account data cannot prove funds',()=>{
 assert.equal(summarizeAccount({is_available:false,balance_infos:[{currency:'USD',total_balance:'-0.01',granted_balance:'0.00',topped_up_balance:'-0.01'}]}).cnyMicros,null);
 for(const response of [{is_available:'true',balance_infos:[]},{is_available:true,balance_infos:[]},{is_available:true,balance_infos:[{currency:'CNY',total_balance:'KEY_ECHO'}]}])
  assert.throws(()=>summarizeAccount(response),/ACCOUNT_RESPONSE_UNVERIFIED/);
});
