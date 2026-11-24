import assert from 'node:assert/strict';
import test from 'node:test';
import { responsesRequestToChat, chatResult, responsesDocument, responsesEvents } from '../../dist/server/flow/responses-wire.js';

const limits = { model: 'deepseek-chat', maxOutputTokens: 8192 };
const wireBody = (over = {}) => ({
    model: 'deepseek-chat',
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    tools: [
        { type: 'function', name: 'get_goal', description: 'read', parameters: { type: 'object', properties: {} } },
    ],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { summary: 'auto' },
    prompt_cache_key: 'cache',
    input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task' }] },
    ],
    ...over,
});

test('translates the recorded Codex Responses request into one chat body', () => {
    const { chat, stream } = responsesRequestToChat(wireBody({ text: { format: { type: 'json_schema', name: 'plan', schema: {} } } }), limits);
    assert.equal(stream, true);
    assert.equal(chat.model, 'deepseek-chat');
    assert.equal(chat.stream, false);
    assert.deepEqual(chat.messages.map(m => m.role), ['system', 'user']);
    assert.equal(chat.messages[0].content, 'rules');
    assert.equal(chat.tools.length, 1);
    assert.equal(chat.tools[0].function.name, 'get_goal');
    assert.equal(chat.tool_choice, 'auto');
    assert.deepEqual(chat.response_format, { type: 'json_object' });
    assert.equal(chat.max_tokens, 8192, 'no max_output_tokens means the pinned ceiling');
});

test('a stricter max_output_tokens is honoured and never raised past the ceiling', () => {
    assert.equal(responsesRequestToChat(wireBody({ max_output_tokens: 512 }), limits).chat.max_tokens, 512);
    assert.equal(responsesRequestToChat(wireBody({ max_output_tokens: 99999 }), limits).chat.max_tokens, 8192);
});

test('function_call and function_call_output items become chat tool turns', () => {
    const { chat } = responsesRequestToChat(wireBody({
        input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task' }] },
            { type: 'function_call', name: 'get_goal', arguments: '{}', call_id: 'call_1' },
            { type: 'function_call_output', call_id: 'call_1', output: '{"goal":null}' },
        ],
    }), limits);
    assert.deepEqual(chat.messages.map(m => m.role), ['user', 'assistant', 'tool']);
    assert.equal(chat.messages[1].tool_calls[0].id, 'call_1');
    assert.equal(chat.messages[2].tool_call_id, 'call_1');
});

test('the adapter fails closed on shapes the CLI has never produced', () => {
    for (const bad of [
        wireBody({ model: 'deepseek-flash' }),
        wireBody({ store: true }),
        wireBody({ input: [{ type: 'image', role: 'user' }] }),
        wireBody({ input: [] }),
        wireBody({ tools: [{ type: 'web_search' }] }),
        wireBody({ tool_choice: 'sometimes' }),
        wireBody({ text: { format: { type: 'yaml' } } }),
    ]) {
        assert.throws(() => responsesRequestToChat(bad, limits), /RESPONSES_REQUEST_INVALID/);
    }
});

test('a chat completion becomes a Responses document with text and usage', () => {
    const result = chatResult({
        id: 'chatcmpl-1', model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
    }, 'deepseek-chat');
    const document = responsesDocument(result);
    assert.equal(document.object, 'response');
    assert.equal(document.status, 'completed');
    assert.equal(document.output[0].type, 'message');
    assert.equal(document.output[0].content[0].text, '{"ok":true}');
    assert.deepEqual(document.usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 });
});

test('tool calls become function_call items and SSE carries the event sequence the CLI accepted', () => {
    const result = chatResult({
        id: 'chatcmpl-2', model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_goal', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
    }, 'deepseek-chat');
    const document = responsesDocument(result);
    assert.equal(document.output[0].type, 'function_call');
    assert.equal(document.output[0].call_id, 'call_9');
    const events = responsesEvents(result);
    for (const type of ['response.created', 'response.output_item.added', 'response.output_item.done', 'response.completed']) {
        assert.match(events, new RegExp('event: ' + type + '\\n'));
    }
    assert.match(events, /"call_id":"call_9"/);
});

test('native GPT Planner 2 preserves its output schema and sends only authorized text',async()=>{
 const {codexPlannerResponsesBody:prepare}=await import('../../dist/server/flow/responses-wire.js');
 const format={type:'json_schema',name:'plan',strict:true,schema:{type:'object'}};
 const source=wireBody({tools:[],text:{format},client_metadata:{session_id:'synthetic'}});
 source.input.unshift({type:'additional_tools',role:'developer',id:'synthetic',tools:[{type:'namespace'}]});
 const policy={...limits,prompt:'task',instructions:'trusted rules',outputSchema:format.schema};
 const out=prepare(source,policy);
 assert.deepEqual(out,{model:limits.model,input:source.input.slice(-1),instructions:'trusted rules',store:false,stream:true,max_output_tokens:8192,text:{format}});
 for(const change of [{text:{}},{text:{format:{...format,schema:{type:'string'}}}},{input:[...source.input,source.input.at(-1)]},{input:[source.input[0]]},{tools:[{type:'web_search'}]},{input:[{type:'function_call'}]},{store:true},{max_output_tokens:0},{previous_response_id:'another'}])
  assert.throws(()=>prepare({...source,...change},policy),{code:'RESPONSES_REQUEST_INVALID'});
});
