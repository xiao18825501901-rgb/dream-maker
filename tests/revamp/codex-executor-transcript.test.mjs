import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexPlannerStream } from '../../dist/server/flow/codex-planner-stream.js';
import { codexExecutorResponsesEvents } from '../../dist/server/flow/responses-wire.js';

// The executor arm of the Responses wire. Go's dmExecutorTranscript admits an ordered sequence of
// message and function_call items and closes on up to sixteen calls (dmCliExecutorToolLimit); the
// TypeScript parser has to read exactly that shape back, or `codex exec` stops at the first tool
// round. These are the shapes the real CLI was observed to send, not invented ones.
const MODEL = 'served-model', QUALIFIED = 'provider/served-model', CEILING = 16;
const call = (n, args = JSON.stringify({ cmd: 'echo ' + n })) => ({ id: 'fc_' + n, type: 'function_call', status: 'completed',
    call_id: 'call_' + n, name: 'exec_command', arguments: args });
const message = text => ({ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] });

function turn(calls, text) {
    const events = [], output = [];
    let index = 0;
    events.push({ type: 'response.created', response: { id: 'resp_1', object: 'response', status: 'in_progress', model: MODEL, output: [], usage: null } });
    for (const item of calls) {
        events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', arguments: '' } });
        events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: item.arguments });
        events.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments });
        events.push({ type: 'response.output_item.done', output_index: index, item });
        output.push(item); index += 1;
    }
    if (text !== null) {
        const m = message(text);
        events.push({ type: 'response.output_item.added', output_index: index, item: { id: m.id, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
        events.push({ type: 'response.content_part.added', item_id: m.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        events.push({ type: 'response.output_text.delta', item_id: m.id, output_index: index, content_index: 0, delta: text });
        events.push({ type: 'response.output_text.done', item_id: m.id, output_index: index, content_index: 0, text });
        events.push({ type: 'response.content_part.done', item_id: m.id, output_index: index, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
        events.push({ type: 'response.output_item.done', output_index: index, item: m });
        output.push(m); index += 1;
    }
    events.push({ type: 'response.completed', response: { id: 'resp_1', object: 'response', status: 'completed', model: MODEL, output,
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } } });
    return events;
}

const run = (events, callsAllowed = true) => {
    const parser = new CodexPlannerStream(MODEL, undefined, callsAllowed);
    let result;
    for (const event of events) result = parser.observe(event);
    return result;
};
const invalid = { code: 'MODEL_GATEWAY_COMPLETION_INVALID' };

test('the executor arm transcribes every call Go admits, in order, up to its ceiling', () => {
    for (const n of [1, 2, 8, 16]) {
        const result = run(turn(Array.from({ length: n }, (_, i) => call(i + 1)), null));
        assert.equal(result.calls.length, n, String(n));
        assert.deepEqual(result.calls.map(c => [c.itemId, c.callId, c.name]), Array.from({ length: n }, (_, i) =>
            ['fc_' + (i + 1), 'call_' + (i + 1), 'exec_command']), String(n));
        assert.equal(result.text, '');
    }
});

test('a turn that asks for nothing still has to answer in text, and only once', () => {
    assert.equal(run(turn([], 'DONE')).text, 'DONE');
    assert.throws(() => run(turn([], null)), invalid);
});

test('a turn with calls may describe them, and a second message item is refused', () => {
    const described = run(turn([call(1)], 'calling'));
    assert.equal(described.text, 'calling');
    assert.equal(described.calls.length, 1);
    const doubled = turn([call(1)], 'a').map(event =>
        event.type === 'response.output_item.done' && event.item?.type === 'message' ? { ...event, item: { ...event.item, id: 'msg_2' } } : event);
    assert.throws(() => run(doubled), invalid);
});

test('the ceiling is the Go one, and the planner lane keeps refusing calls outright', () => {
    assert.throws(() => run(turn(Array.from({ length: CEILING + 1 }, (_, i) => call(i + 1)), null)), invalid);
    assert.throws(() => run(turn([call(1)], null), false), invalid);
    assert.equal(run(turn([], 'DONE'), false).text, 'DONE');
});

test('the echoed call has to be the one that was streamed', () => {
    const drifted = turn([call(1)], null).map(event => event.type === 'response.completed'
        ? { ...event, response: { ...event.response, output: [{ ...event.response.output[0], arguments: '{"cmd":"other"}' }] } } : event);
    assert.throws(() => run(drifted), invalid);
});

test('the rebuilt client transcript carries the calls back in their order', () => {
    const result = run(turn([call(1), call(2)], null));
    const events = codexExecutorResponsesEvents({ id: result.id, model: MODEL, text: result.text, calls: result.calls,
        usage: { inputTokens: 10, outputTokens: 3 } }).split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('data: ')[1]));
    const items = events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
    assert.deepEqual(items.map(item => [item.type, item.call_id]), [['function_call', 'call_1'], ['function_call', 'call_2']]);
});
