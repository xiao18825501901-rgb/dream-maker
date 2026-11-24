import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPlanContent } from '../../dist/web/project-plan-view.js';
import { fixtureProjectPlan } from '../fixtures/full-project-plan.mjs';
test('complete P1 plan exposes use conditions, tasks, real research status and assumptions in plain sections',()=>{
 const body=fixtureProjectPlan([{id:'R001',text:'原始要求',origin:'USER',sources:['description']}]);
 const html=projectPlanContent(body);
 for(const label of ['推荐的做法','做完后怎样使用','分几步完成','如何检查成果','查找与复用','建议与待确认条件'])assert.ok(html.includes(label),label);
 assert.match(html,/暂未完成公开检索/);assert.match(html,/本次方案按原创路线设计/);
 assert.match(html,/本地界面与本地数据存储/);assert.doesNotMatch(html,/已通过|没有开源项目|验收成功/);
});
test('model prose and source descriptions are escaped, and links only use approved repository origins',()=>{
 const body=fixtureProjectPlan([{id:'R001',text:'要求',origin:'USER',sources:['description']}]);
 body.goal='<img src=x onerror=alert(1)>';body.research.sourceRefs=[{webUrl:'javascript:alert(1)',commit:'a'.repeat(40),snapshotHash:'b'.repeat(64)}];
 const html=projectPlanContent(body);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|href="javascript:|onerror="/);
});
