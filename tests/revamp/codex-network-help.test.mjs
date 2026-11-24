// UI copy and escaping tests only. No account, controller, login or network operation.
import test from 'node:test';import assert from 'node:assert/strict';
import {friendlyUiError}from'../../dist/web/plain-ui-error.js';import{helpPage}from'../../dist/web/flow-help-view.js';

test('a missing Windows-to-Linux route is described as an unverified path rather than a policy refusal',()=>{
 const text=friendlyUiError({code:'CODEX_WSL_PROXY_BINDING_UNVERIFIED',message:'https://private.invalid/?token=PRIVATE_UNTRUSTED_DIAGNOSTIC'});
 assert.match(text,/网络路径/);assert.match(text,/Windows/);assert.match(text,/Linux/);assert.match(text,/未.*核验|尚未.*核验/);
 assert.doesNotMatch(text,/PRIVATE_UNTRUSTED_DIAGNOSTIC|https:|切换节点|切换地区|重新登录|地区不支持/);
});

test('account and catalog failures retain their separate reasons and never promise an automatic substitute',()=>{
 const account=friendlyUiError({code:'CODEX_SUBSCRIPTION_ACCOUNT_REQUIRED'}),quota=friendlyUiError({code:'CODEX_INCLUDED_USAGE_UNAVAILABLE'}),model=friendlyUiError({code:'CODEX_MODEL_NOT_LISTED'});
 assert.match(account,/账户/);assert.match(quota,/套餐|额度/);assert.match(model,/模型.*清单|清单.*模型/);
 for(const text of [account,quota,model])assert.doesNotMatch(text,/切换节点|切换地区|重新登录|CODEX_/);
});

test('an unspecified 403 or RPC error cannot be relabeled as a confirmed region or account policy denial',()=>{
 for(const code of ['RUNNER_RPC_ERROR','UPSTREAM_HTTP_403']){
  const text=friendlyUiError({code,message:'private upstream text token_exchange_failed 403'});
  assert.doesNotMatch(text,/地区不支持|地区限制|账户已封禁|private upstream text|token_exchange_failed/);
 }
});

test('both Help reading levels explain all authentication phases without a login or routing action',()=>{
 for(const simple of [false,true]){
  const html=helpPage({},simple);assert.match(html,/id="help-CODEX_NETWORK_SCOPE"/);assert.match(html,/浏览器授权/);assert.match(html,/本地回调/);assert.match(html,/令牌交换/);assert.match(html,/模型请求/);assert.match(html,/官方/);
  assert.doesNotMatch(html,/data-action="(?:login|clash-verify|start|build)"/);
 }
});
