// Production view field compatibility using explicitly synthetic frontend-review data.
import test from 'node:test';import assert from 'node:assert/strict';
import {reviewerSourceView} from '../fixtures/reviewer-source-view.mjs';
for(const [source,label] of [['DSH','DSH 审查'],['CODEX','Codex 审查'],['INDEPENDENT_API','独立接口审查'],['DEMO_RULES','规则审查']])test('review source '+source+' renders its actual kind and retains the synthetic badge',async()=>{const html=await reviewerSourceView(source);assert.ok(html.includes(label+'：'));assert.match(html,/合成演示，不是实际审查/);if(source!=='DEMO_RULES')assert.doesNotMatch(html,/规则审查：/);});
