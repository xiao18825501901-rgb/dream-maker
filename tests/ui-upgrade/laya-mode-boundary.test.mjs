// The Laya page must describe the current run's frozen mode (off/shadow/advisory),
// not the global setting, and must never call shadow "advisory".
import test from 'node:test';
import assert from 'node:assert/strict';
import {layaPage} from '../../dist/web/flow-workspace-view.js';

const classic=(mode,enabled=mode!=='off')=>({mode:'classic',laya:{enabled,mode,roles:['planner2','executor','reviewer']}});
const current=(flowName,flowConfig)=>({id:'run_current',projectId:'project_current',specId:'spec_current',state:'IMPLEMENTING',tasks:[],flowName,flowConfig});
const view=(globalMode,flowConfig,flowName='classic')=>({
  mode:'local',
  snapshot:{
    project:{id:'project_current',specId:'spec_current'},
    spec:{id:'spec_current',stale:false},
    runs:[current(flowName,flowConfig)]
  },
  settings:{config:{laya:{mode:globalMode}}},
  layaSummary:{turns:3,receivedAdviceTurns:2,influencedTurns:1}
});

test('shadow run is described as record-only even when the global setting is advisory',()=>{
  const html=layaPage(view('advisory',classic('shadow')));
  assert.match(html,/影子模式/);
  assert.match(html,/不进入角色任务/);
  assert.doesNotMatch(html,/当前配置为辅助模式/);
  assert.doesNotMatch(html,/辅助资格尚待核验/);
});

test('advisory run is described as advice and still needs real qualification',()=>{
  const html=layaPage(view('off',classic('advisory')));
  assert.match(html,/建议模式/);
  assert.match(html,/辅助资格尚待核验/);
  assert.doesNotMatch(html,/本地 Laya 未启用/);
});

test('off and custom runs never borrow shadow or advisory wording',()=>{
  const off=layaPage(view('shadow',classic('off',false)));
  assert.match(off,/本地 Laya 未启用/);
  assert.doesNotMatch(off,/影子模式|建议模式/);
  const custom=layaPage(view('advisory',{mode:'custom',laya:{enabled:false,mode:'off',roles:[]}},'custom'));
  assert.match(custom,/完全自定义 · 不使用 Laya/);
  assert.match(custom,/未启用/);
  assert.doesNotMatch(custom,/影子模式|建议模式|辅助资格尚待核验/);
});

test('without a current run the global mode is only a configuration statement',()=>{
  const html=layaPage({mode:'local',snapshot:{project:{id:'p',specId:'s'},spec:{id:'s',stale:false},runs:[]},settings:{config:{laya:{mode:'shadow'}}},layaSummary:undefined});
  assert.match(html,/影子模式/);
  assert.match(html,/本轮尚未开始/);
});
