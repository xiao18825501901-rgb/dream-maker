import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CLASH_RESPONSE_HEADER_TIMEOUT_MS,
  MAX_CLASH_RESPONSE_HEADER_TIMEOUT_MS,
  resolveClashResponseHeaderTimeoutMs
} from '../../dist/server/clash-transport.js';

test('the controlled transport does not impose the retired 30-second response-header ceiling',()=>{
  assert.equal(DEFAULT_CLASH_RESPONSE_HEADER_TIMEOUT_MS, 300000);
  assert.equal(MAX_CLASH_RESPONSE_HEADER_TIMEOUT_MS, 300000);
  assert.equal(resolveClashResponseHeaderTimeoutMs(), 300000);
});

test('a bounded per-request header deadline can be shorter than the transport ceiling',()=>{
  assert.equal(resolveClashResponseHeaderTimeoutMs(75), 75);
  assert.equal(resolveClashResponseHeaderTimeoutMs(120000), 120000);
});

test('invalid response-header deadlines fail closed instead of silently removing the timeout',()=>{
  for(const value of [0,49,-1,300001,Number.NaN,1.5,'30000']){
    assert.throws(()=>resolveClashResponseHeaderTimeoutMs(value),{code:'CLASH_RESPONSE_HEADER_TIMEOUT_INVALID'});
  }
});
