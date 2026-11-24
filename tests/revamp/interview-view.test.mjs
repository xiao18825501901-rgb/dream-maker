import test from 'node:test';
import assert from 'node:assert/strict';
import { shell, gateContent } from '../../dist/web/views.js';
import { harness } from '../helpers.mjs';
function view(project) { return { mode:'local',screen:'project',projects:[project],snapshot:{project,spec:null,runs:[],records:[]},
 settings:null,tab:'work',busy:false,error:'',events:[],connection:'connected',railClosed:false,
 files:[],fileName:'',fileText:'',previewUrl:'',specSearch:'',logLimit:40,clash:null,draft:()=>'',hasDraft:()=>false }; }
test('four labeled keyboard choices and a separate free-input field render without embedding the question as an answer', async t => {
 const h=harness(t), p=h.interviews.create('真实本地视图','本地记录工具','demo');
 const current=await h.interviews.next(p.id),html=shell(view(current));
 assert.equal((html.match(/name="optionId"/g)??[]).length,4);
 assert.match(html,/<fieldset[^>]*class="answer-choices"/);
 assert.match(html,/<legend>[^<]+<\/legend>/);
 assert.match(html,/<label for="answer">5\. 自由输入/);
 assert.doesNotMatch(html,/<textarea[^>]+id="answer"[^>]*required/);
 assert.match(html,/data-action="clear-answer-choices"/);
});
test('five-question alternatives render the matching counter and continue action', async t => {
 const h=harness(t),p=h.interviews.create('方向','小工具','demo');p.batchSize=5;p.batchTarget=5;p.interviewMode='ALTERNATIVE';
 const html=shell(view(p)),gate=gateContent(view(p));
 assert.match(html,/aria-label="本组已回答" aria-valuemin="0" aria-valuemax="5" aria-valuenow="0"/);
 assert.match(gate,/继续下一组五题/);
 assert.match(html,/可以随时结束/);
});
