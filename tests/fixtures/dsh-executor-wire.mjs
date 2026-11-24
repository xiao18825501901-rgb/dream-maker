export const model = 'fixture-dsh-executor';
export const provider = 'fixture';
export const qualified = provider + '/' + model;
export const system = ['You are the frozen Dream Maker executor.', 'Use only the approved desk tools.'];
export const systemText = system.join('\n\n');
export const prompt = 'Inspect src/app.ts, then report the first line.';
export const answer = 'fixture executor 你好，第一行是 export const a = 1;';
export const readSchema = {type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false};
export const searchSchema = {type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false};
export const writeSchema = {type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false};
export const tools = () => [
    {name:'desk_read',description:'Read one project file.',input_schema:structuredClone(readSchema)},
    {name:'desk_search',description:'Search project text.',input_schema:structuredClone(searchSchema)},
];
export const toolNames = tools().map(tool => tool.name);
export function context(protocol = 'chat-completions', role = 'executor') {
    const route = {runtime:'dsh',provider,protocol,model,authentication:'api_key',authRef:'offline_auth',accountRef:'offline_account',upstreamAccountRef:provider+'/offline_peer'};
    return {route,role,accounts:[{...route,capabilities:[{model,protocol}]}],limits:{model,maxInputTokens:64,maxOutputTokens:512},
        assertCurrent(){},assertSafe(){},signal:new AbortController().signal};
}
export function user(text = prompt) { return {role:'user',content:[{type:'text',text}]}; }
export function assistantText(text) { return {role:'assistant',content:[{type:'text',text}]}; }
export function assistantCalls(calls, text) {
    return {role:'assistant',content:[...(text === undefined ? [] : [{type:'text',text}]),
        ...calls.map(call => ({type:'tool_use',id:call.id,name:call.name,input:call.input}))]};
}
export function results(list) {
    return {role:'user',content:list.map(row => ({type:'tool_result',tool_use_id:row.id,
        content:typeof row.output === 'string' ? [{type:'text',text:row.output}] : row.output,
        ...(row.error === undefined ? {} : {is_error:row.error})}))};
}
export function requestBody() {
    return {model,stream:true,max_tokens:512,thinking:{type:'disabled'},system:system.map(text => ({type:'text',text})),
        messages:[user()],tools:tools()};
}
export const roundTrip = () => {
    const body = requestBody();
    body.messages = [user(), assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'src/app.ts'}}]),
        results([{id:'toolu_01',output:'export const a = 1;'}])];
    return body;
};
export const parallel = () => {
    const body = requestBody();
    body.messages = [user(), assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'src/app.ts'}},
        {id:'toolu_02',name:'desk_search',input:{text:'export const'}}]),
        results([{id:'toolu_01',output:'export const a = 1;'},{id:'toolu_02',output:'src/app.ts:1'}]),
        assistantCalls([{id:'toolu_03',name:'desk_read',input:{path:'src/b.ts'}}]),results([{id:'toolu_03',output:'export const b = 2;'}])];
    return body;
};
export const ingress = body => ({method:'POST',path:'/v1/messages',contentType:'application/json',version:'2023-06-01',
    body:typeof body === 'string' ? body : JSON.stringify(body)});
export const usage = () => ({prompt_tokens:8,completion_tokens:3,prompt_tokens_details:{cached_tokens:2},total_tokens:11});
export const chunk = value => 'data: ' + JSON.stringify(value) + '\n\n';
const head = (choices, extra = {}) => ({id:'fixture_chat_1',object:'chat.completion.chunk',created:1,model:qualified,choices,...extra});
export function textStream(text = answer, usageRaw = usage()) {
    return [
        chunk(head([{index:0,delta:{role:'assistant',content:''},finish_reason:null}])),
        chunk(head([{index:0,delta:{content:text.slice(0,4)},finish_reason:null}])),
        chunk(head([{index:0,delta:{content:text.slice(4)},finish_reason:null}])),
        chunk(head([{index:0,delta:{},finish_reason:'stop'}],{usage:usageRaw})),
        'data: [DONE]\n\n',
    ].join('');
}
export function usageTrailerStream(text = answer, usageRaw = usage()) {
    return [
        chunk(head([{index:0,delta:{role:'assistant',content:text},finish_reason:null}])),
        chunk(head([{index:0,delta:{},finish_reason:'stop'}])),
        chunk(head([],{usage:usageRaw})),
        'data: [DONE]\n\n',
    ].join('');
}
const call = (index, id, name, args) => ({index,id,type:'function',function:{name,arguments:args}});
export function toolStream(calls = [{id:'call_fixture_1',name:'desk_read',arguments:'{"path":"src/app.ts"}'}], usageRaw = usage()) {
    const frames = [chunk(head([{index:0,delta:{role:'assistant',content:''},finish_reason:null}]))];
    for (const row of calls) frames.push(chunk(head([{index:0,delta:{tool_calls:[call(row.index,row.id,row.name,row.arguments)]},finish_reason:null}])));
    frames.push(chunk(head([{index:0,delta:{},finish_reason:'tool_calls'}],{usage:usageRaw})));
    frames.push('data: [DONE]\n\n');
    return frames.join('');
}
/** Two parallel calls whose fragments interleave, to prove the accumulation is index-scoped. */
export function parallelStream() {
    const open = (index, id, name) => chunk(head([{index:0,delta:{tool_calls:[call(index,id,name,'')]},finish_reason:null}]));
    const more = (index, args) => chunk(head([{index:0,delta:{tool_calls:[{index,function:{arguments:args}}]},finish_reason:null}]));
    return [
        chunk(head([{index:0,delta:{role:'assistant',content:''},finish_reason:null}])),
        open(0,'call_a','desk_read'),
        open(1,'call_b','desk_search'),
        more(1,'{"text":"export const"'),
        more(0,'{"path":"src/app.ts"'),
        more(1,'}'),
        more(0,'}'),
        chunk(head([{index:0,delta:{},finish_reason:'tool_calls'}],{usage:usage()})),
        'data: [DONE]\n\n',
    ].join('');
}
export const upstream = (body, media = 'text/event-stream') => new Response(body,{headers:{'content-type':media}});
export const frames = sse => sse.trimEnd().split('\n\n').map(block => JSON.parse(block.split('\n')[1].slice(6)));

// ---------------------------------------------------------------------------------------------
// Responses fixtures. One executor answer is a sequence of output items: at most one message item
// and up to eight function_call items, streamed item by item and closed by response.completed.
// ---------------------------------------------------------------------------------------------
export const responseId = 'resp_fixture_1';
export const responsesUsage = () => ({input_tokens:8,output_tokens:3,total_tokens:11,input_tokens_details:{cached_tokens:2}});
const outputText = text => ({type:'output_text',text,annotations:[]});
const messageItem = (id,text) => ({id,type:'message',status:'completed',role:'assistant',content:[outputText(text)]});
const callItem = ({id,call_id,name,arguments:args}) => ({id,type:'function_call',status:'completed',call_id,name,arguments:args});
function messageEvents(id,text,index) {
    return [
        {type:'response.output_item.added',output_index:index,item:{id,type:'message',status:'in_progress',role:'assistant',content:[]}},
        {type:'response.content_part.added',item_id:id,output_index:index,content_index:0,part:outputText('')},
        {type:'response.output_text.delta',item_id:id,output_index:index,content_index:0,delta:text.slice(0,4)},
        {type:'response.output_text.delta',item_id:id,output_index:index,content_index:0,delta:text.slice(4)},
        {type:'response.output_text.done',item_id:id,output_index:index,content_index:0,text},
        {type:'response.content_part.done',item_id:id,output_index:index,content_index:0,part:outputText(text)},
        {type:'response.output_item.done',output_index:index,item:messageItem(id,text)},
    ];
}
function callEvents(call,index) {
    return [
        {type:'response.output_item.added',output_index:index,item:{id:call.id,type:'function_call',status:'in_progress',call_id:call.call_id,name:call.name,arguments:''}},
        {type:'response.function_call_arguments.delta',item_id:call.id,output_index:index,delta:call.arguments.slice(0,5)},
        {type:'response.function_call_arguments.delta',item_id:call.id,output_index:index,delta:call.arguments.slice(5)},
        {type:'response.function_call_arguments.done',item_id:call.id,output_index:index,arguments:call.arguments},
        {type:'response.output_item.done',output_index:index,item:callItem(call)},
    ];
}
/** Ordered parts: {kind:'message',id,text} or {kind:'call',id,call_id,name,arguments}. */
export function responsesEvents(parts, options = {}) {
    const {usage: usageRaw = responsesUsage(), response = {}} = options;
    const events = [
        {type:'response.created',response:{id:responseId,model:qualified,status:'in_progress',error:null,incomplete_details:null}},
        {type:'response.in_progress',response:{id:responseId,model:qualified,status:'in_progress',error:null,incomplete_details:null}},
    ];
    const output = [];
    parts.forEach((part,index) => {
        if (part.kind === 'message') {events.push(...messageEvents(part.id,part.text,index));output.push(messageItem(part.id,part.text));}
        else {events.push(...callEvents(part,index));output.push(callItem(part));}
    });
    events.push({type:'response.completed',response:{id:responseId,model:qualified,status:'completed',error:null,
        incomplete_details:null,output,usage:usageRaw,...response}});
    return events;
}
/** The wire is densely sequenced. A named event is emitted as 'event:' only when asked for. */
export const responsesFrame = (event,index) => {
    const {name,...payload} = event;
    return (name === undefined ? '' : 'event: ' + name + '\n') + 'data: ' + JSON.stringify({sequence_number:index,...payload}) + '\n\n';
};
export const serializeResponses = (events,tail = '') => events.map((event,index) => responsesFrame(event,index)).join('') + tail;
export const responsesStream = (parts,options = {}) => serializeResponses(responsesEvents(parts,options),options.sentinel ? 'data: [DONE]\n\n' : '');
export const textParts = (text = answer) => [{kind:'message',id:'msg_fixture_1',text}];
export const callParts = (...calls) => calls.map(call => ({kind:'call',...call}));
