// OFFLINE contract only: no CLI, model, account or dispatch.
import test from 'node:test';import assert from 'node:assert/strict';
import {assertCodexMagpieConfig,codexMagpieToml} from '../../dist/server/providers/codex-magpie-config.js';

const input=()=>({model:'deepseek-chat',baseUrl:'http://127.0.0.1:45001/v1',envKey:'DM_MAGPIE_GATEWAY'});

test('the generated Codex provider block round-trips through its own validator',()=>{
 const text=codexMagpieToml(input());
 assert.match(text,/^model = "deepseek-chat"$/m);
 assert.match(text,/^model_provider = "magpie"$/m);
 assert.match(text,/^base_url = "http:\/\/127\.0\.0\.1:45001\/v1"$/m);
 assert.match(text,/^env_key = "DM_MAGPIE_GATEWAY"$/m);
 // The pinned CLI 0.162.0 dropped the chat wire; thread/start rejects it with -32600.
 assert.match(text,/^wire_api = "responses"$/m);
 assert.deepEqual(assertCodexMagpieConfig(text),{model:'deepseek-chat',baseUrl:'http://127.0.0.1:45001/v1',envKey:'DM_MAGPIE_GATEWAY',wireApi:'responses'});
});

test('only a loopback gateway origin is accepted',()=>{
 for(const baseUrl of ['https://api.openai.com/v1','http://127.0.0.1:45001/v2','http://localhost:45001/v1','http://127.0.0.1:45001/v1?x=1','http://user:pass@127.0.0.1:45001/v1'])
  assert.throws(()=>codexMagpieToml({...input(),baseUrl}),{code:'CODEX_MAGPIE_CONFIG_INVALID'});
});

test('model, env key and shape are refused when they widen the block',()=>{
 for(const patch of [{model:'deepseek chat'},{model:'https://evil/v1'},{envKey:'dm_magpie'},{envKey:'A-B'}])assert.throws(()=>codexMagpieToml({...input(),...patch}),{code:'CODEX_MAGPIE_CONFIG_INVALID'});
 assert.throws(()=>codexMagpieToml({...input(),extra:'x'}),{code:'CODEX_MAGPIE_CONFIG_INVALID'});
 const text=codexMagpieToml(input());
 assert.throws(()=>assertCodexMagpieConfig(text+'\nwire_api = "responses"\n'),{code:'CODEX_MAGPIE_CONFIG_INVALID'});
 assert.throws(()=>assertCodexMagpieConfig(text.replace('[model_providers.magpie]\n','')),{code:'CODEX_MAGPIE_CONFIG_INVALID'});
 assert.throws(()=>assertCodexMagpieConfig(text.replace('"responses"','"chat"')),{code:'CODEX_MAGPIE_CONFIG_INVALID'});
});

test('ChatGPT uses separate gateway authentication on the native Responses path', () => {
 const config = {model:'gpt-6-luna',baseUrl:'http://127.0.0.1:45001/backend-api/codex',envKey:'DM_GATEWAY_TOKEN',authentication:'chatgpt'};
 const text = codexMagpieToml(config);
 assert.match(text, /^requires_openai_auth = true$/m);
 assert.match(text, /^env_http_headers = \{ "X-DM-Gateway" = "DM_GATEWAY_TOKEN" \}$/m);
 assert.doesNotMatch(text, /^env_key =/m);
 assert.deepEqual(assertCodexMagpieConfig(text), {...config,wireApi:'responses'});
 for(const patch of [{baseUrl:input().baseUrl},{envKey:'OPENAI_API_KEY'},{authentication:'unknown'}])
  assert.throws(()=>codexMagpieToml({...config,...patch}),{code:'CODEX_MAGPIE_CONFIG_INVALID'});
 for(const altered of [text.replace('X-DM-Gateway','Authorization'),text.replace(' = true',' = false'),text+'env_key = "EXTRA"\n'])
  assert.throws(()=>assertCodexMagpieConfig(altered),{code:'CODEX_MAGPIE_CONFIG_INVALID'});
});
