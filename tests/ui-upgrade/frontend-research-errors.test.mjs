import test from 'node:test';
import assert from 'node:assert/strict';
import {researchPage} from '../../dist/web/research-view.js';
test('incomplete research response stays an unknown state without crashing the project page',()=>{
 const view={mode:'local',snapshot:{research:[]},researchPanel:{operations:[{status:'COMPLETED',result:{status:'SEARCHED_WITHIN_BOUNDS',snapshots:[null,{}],results:null}}]}};
 let html;assert.doesNotThrow(()=>{html=researchPage(view);});assert.match(html,/检索暂未完成/);assert.doesNotMatch(html,/已完成本次限定范围/);
});
