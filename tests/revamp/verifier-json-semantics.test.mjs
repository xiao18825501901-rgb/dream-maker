// Controller oracle comparisons, not model or project acceptance.
import test from 'node:test';import assert from 'node:assert/strict';
import {validateVerifierPlan,checkVerifierCase} from '../../dist/server/wsl-verifier.js';
const specHash='a'.repeat(64),base={id:'A1',requirementIds:['R1'],runtime:'node',entry:'main.mjs',args:[],stdin:'',expectedExitCode:0};
const plan=c=>validateVerifierPlan({schema:'dream-maker.cli-verifier.v1',specHash,cases:[c]},specHash,['R1']).cases[0];
test('JSON oracle checks values while allowing ordinary formatting and object key order',()=>{
 const expected={perCategory:[{category:'餐饮',amount:3}],total:3},c=plan({...base,expectedJson:expected});expected.total=99;
 assert.equal(checkVerifierCase(c,{exitCode:0,stdout:' { "total": 3, "perCategory": [ {"amount":3,"category":"餐饮"} ] }\n',stderr:''}).ok,true);
 for(const stdout of ['{"perCategory":[],"total":3}','{"total":3,"perCategory":[{"category":"餐饮","amount":"3"}]}','{} PASS','{"perCategory":[{"category":"餐饮","amount":3}],"total":4}'])assert.equal(checkVerifierCase(c,{exitCode:0,stdout,stderr:''}).ok,false);
});
test('a bounded stderr expression verifies Chinese diagnostics without inventing exact wording',()=>{
 const c=plan({...base,expectedExitCode:1,expectedStdout:'',expectedStderrMatch:'[一-鿿]'});
 assert.equal(checkVerifierCase(c,{exitCode:1,stdout:'',stderr:'第 1 条记录：金额必须为整数。\n'}).ok,true);
 for(const stderr of ['','TypeError: invalid amount'])assert.equal(checkVerifierCase(c,{exitCode:1,stdout:'',stderr}).ok,false);
});
test('JSON/diagnostic variants remain exclusive and bounded; non-finite JSON cannot match null',()=>{
 for(const c of [{...base,expectedJson:{},expectedStdout:'{}'},{...base,expectedJson:undefined},{...base,expectedJson:{n:Infinity}},{...base,expectedJson:'x'.repeat(65537)},{...base,expectedStdout:'',expectedStderr:'x',expectedStderrMatch:'x'},{...base,expectedStdout:'',expectedStderrMatch:'['},{...base,expectedStdout:'',expectedStderrMatch:'x'.repeat(301)}])assert.throws(()=>plan(c));
 assert.throws(()=>plan({...base,expectedStdout:'',expectedStderrMatch:3}));
 const c=plan({...base,expectedJson:null});assert.equal(checkVerifierCase(c,{exitCode:0,stdout:'null',stderr:''}).ok,true);assert.equal(checkVerifierCase(c,{exitCode:0,stdout:'1e309',stderr:''}).ok,false);
 for(const [expectedJson,stdout]of [[null,'"null"'],[3,'"3"'],[false,'"false"']])assert.equal(checkVerifierCase(plan({...base,expectedJson}),{exitCode:0,stdout,stderr:''}).ok,false,'JSON primitive types remain distinct');
});
test('diagnostic oracles can distinguish a truncation near the end from offset zero without freezing the full wording',()=>{
 const c=plan({...base,expectedExitCode:1,expectedStdout:'',expectedStderrMatch:'^(?=[\\s\\S]*[㐀-鿿])(?=[\\s\\S]*(?:字符偏移\\s*13|第\\s*1\\s*行第\\s*14\\s*列))[\\s\\S]+$'});
 assert.equal(checkVerifierCase(c,{exitCode:1,stdout:'',stderr:'错误：标准输入不是合法 JSON，末尾附近，字符偏移 13。\n'}).ok,true);
 assert.equal(checkVerifierCase(c,{exitCode:1,stdout:'',stderr:'错误：标准输入不是合法 JSON（第 1 行第 1 列附近，字符偏移 0）。\n'}).ok,false);
 assert.equal(checkVerifierCase(c,{exitCode:1,stdout:'',stderr:'Unexpected end near offset 13\n'}).ok,false);
});
