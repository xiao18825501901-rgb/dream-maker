import assert from 'node:assert/strict';
import test from 'node:test';
import { chatSupervisorResponsesBody, chatSupervisorCompletion } from '../../dist/server/flow/chat-supervisor-responses.js';
import { CodexPlannerStream } from '../../dist/server/flow/codex-planner-stream.js';
import { responsesEvents } from '../../dist/server/flow/responses-wire.js';

const limits = {model: 'selected-model', prompt: 'Review the frozen packet.📝', instructions: 'Controller role rules.', maxOutputTokens: 64};
const user = content => ({role: 'user', content});
const part = text => ({type: 'text', text});
const request = (messages, extra = {}) => ({model: limits.model, messages, max_tokens: 80, stream: false, ...extra});
const rawText = '  Output\nwith exact spacing.  ';
const qualifiedModel = 'provider/' + limits.model;

for (const [name, messages] of Object.entries({
    plain: [{role: 'system', content: 'CLI-generated context'}, user(limits.prompt)],
    wrapped: [{role: 'developer', content: [part('CLI-generated rules')]}, user([part('<task>' + limits.prompt + '</task>'), part('environment context')])],
})) {
    test(name + ' private CLI envelope produces exactly one frozen text input', () => {
        const inbound = request(messages);
        const before = structuredClone(inbound);
        const expected = {model: limits.model, instructions: limits.instructions, store: false, stream: true, max_output_tokens: 64,
            input: [{type: 'message', role: 'user', content: [{type: 'input_text', text: limits.prompt}]}]};
        assert.deepEqual(chatSupervisorResponsesBody(inbound, limits), expected);
        assert.deepEqual(inbound, before);
        assert.equal(chatSupervisorResponsesBody(request(messages, {max_tokens: 10}), limits).max_output_tokens, 10);
    });
}

test('rejects drifted, duplicated or misplaced prompts and unsupported Chat structures', () => {
    const good = request([user(limits.prompt)]);
    const invalid = [request([]), request([user('other')]), request([{role: 'system', content: limits.prompt}]),
        request([user([part(limits.prompt), part(limits.prompt)])]), request([user(limits.prompt.repeat(2))]),
        request([user(limits.prompt), user(limits.prompt)]), request([user(limits.prompt), {role: 'assistant', content: 'extra'}]),
        request([user(limits.prompt), user([{type: 'image_url'}])]), request([user(limits.prompt), user([])]),
        request([user([{type: 'text', text: limits.prompt, extra: 1}])]), request([user([limits.prompt])]),
        request([{...user(limits.prompt), tool_calls: []}]), request(Array(65).fill(user(limits.prompt))),
        ...[{model:'wrong'}, {stream:true}, {stream:undefined}, {tools:[]}, {functions:[]}, {tool_choice:'none'},
            {store:true}, {previous_response_id:'resp_other'}, {max_tokens:0}, {max_tokens:0.5}, {max_tokens:'32'}].map(extra => ({...good,...extra}))];
    for (const body of invalid) assert.throws(() => chatSupervisorResponsesBody(body, limits), {code:'RESPONSES_REQUEST_INVALID'});
    assert.throws(() => chatSupervisorResponsesBody(request([user('aaaa')]), {...limits, prompt:'aaa'}), {code:'RESPONSES_REQUEST_INVALID'});
    for (const extra of [{prompt:''}, {instructions:''}, {maxOutputTokens:0}, {maxOutputTokens:16001}])
        assert.throws(() => chatSupervisorResponsesBody(good, {...limits,...extra}), {code:'RESPONSES_REQUEST_INVALID'});
});

function terminal(change = () => {}) {
    const source = responsesEvents({id:'upstream-01', model:qualifiedModel, content:rawText, toolCalls:[], usage:{prompt_tokens:12, completion_tokens:3}});
    const events = source.trimEnd().split('\n\n').map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)));
    const last = events.at(-1).response;
    last.usage.input_tokens_details = {cached_tokens:4};
    change(last, events);
    const parser = new CodexPlannerStream(limits.model, {qualifiedModel, maxInputTokens:32, maxOutputTokens:limits.maxOutputTokens});
    let result;
    for (const event of events) result = parser.observe(event);
    return result;
}

test('validated Responses terminal produces one buffered Chat result with exact text, ID and cache', () => {
    const completed = terminal();
    const chat = chatSupervisorCompletion(completed, limits.model);
    assert.equal(chat.id, completed.id);
    assert.equal(chat.model, limits.model);
    assert.deepEqual(chat.choices, [{index:0, finish_reason:'stop', message:{role:'assistant',content:rawText}}]);
    assert.deepEqual(chat.usage,{prompt_tokens:12, completion_tokens:3, total_tokens:15, prompt_tokens_details:{cached_tokens:4}, prompt_cache_hit_tokens:4});
    assert.equal(chatSupervisorCompletion(terminal(last => {last.usage.input_tokens_details.cached_tokens = 0;}), limits.model).usage.prompt_cache_hit_tokens, 0);
});

test('unknown or invalid cache, inconsistent counts and exceeded reservation cannot produce successful Chat', () => {
    for (const change of [last => {delete last.usage;}, last => {delete last.usage.input_tokens_details;}]) {
        assert.throws(() => chatSupervisorCompletion(terminal(change), limits.model), {code:'NATIVE_USAGE_UNKNOWN'});
    }
    assert.throws(() => chatSupervisorCompletion(terminal(last => Object.assign(last.usage, {input_tokens:33,total_tokens:36})), limits.model), {code:'MODEL_GATEWAY_USAGE_LIMIT_EXCEEDED'});
    for (const change of [last => {last.usage.input_tokens_details.cached_tokens=13;}, last => {last.usage.total_tokens++;},
        last => {last.model='different-model';}, last => {last.output[0].content[0].text='replacement';},
        (_, events) => {events.find(e => e.type==='response.output_item.added').item.type='function_call';}])
        assert.throws(() => terminal(change), {code:'MODEL_GATEWAY_COMPLETION_INVALID'});
});
