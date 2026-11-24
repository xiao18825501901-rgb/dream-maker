import test from 'node:test';
import assert from 'node:assert/strict';
import {userPlanHome} from '../../dist/web/user-plan-view.js';
test('standalone frontend review cannot choose Live in its plan form',()=>{
 const html=userPlanHome({product:'dreamflow',mode:'public-demo',presentation:'frontend-review',draft:()=>'',projects:[]});assert.doesNotMatch(html,/<option value="live"/);assert.match(html,/<option value="demo"/);
});
test('real local standalone plan form retains explicit Live and fixed Demo choices',()=>{
 const html=userPlanHome({product:'dreamflow',mode:'local',draft:()=>'',projects:[]});assert.match(html,/<option value="live"/);assert.match(html,/<option value="demo"/);
});
