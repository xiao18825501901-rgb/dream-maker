import {responsesEvents} from '../../dist/server/flow/responses-wire.js';
export const model = 'fixture-dsh-supervisor';
export const prompt = 'DreamFlow frozen synthetic supervision packet';
export const system = 'You are the frozen Dream Maker reviewer supervisor.';
export const tool = 'submit_review';
export const inputSchema = {type:'object',properties:{verdict:{type:'string'}},required:['verdict'],additionalProperties:false};
export const answer = 'fixture supervision 你好';
export const toolInput = {verdict:'pass',findings:[]};
export const toolArguments = JSON.stringify(toolInput);
export function context(protocol='chat-completions',role='reviewer') {
    const route = {runtime:'dsh',provider:'fixture',protocol,model,authentication:'api_key',authRef:'offline_auth',accountRef:'offline_account',upstreamAccountRef:'fixture/offline_peer'};
    return {route,role,accounts:[{...route,capabilities:[{model,protocol}]}],limits:{model,maxInputTokens:64,maxOutputTokens:512},
        assertCurrent(){},assertSafe(){},signal:new AbortController().signal};
}
export function requestBody() {
    return {model,stream:true,max_tokens:512,thinking:{type:'disabled'},system,
        messages:[{role:'user',content:[{type:'text',text:prompt}]}],
        tools:[{name:tool,description:'Submit the frozen review.',input_schema:inputSchema}]};
}
export const ingress = body => ({method:'POST',path:'/v1/messages',contentType:'application/json',version:'2023-06-01',body:typeof body==='string'?body:JSON.stringify(body)});
const usage = () => ({prompt_tokens:8,completion_tokens:3,prompt_tokens_details:{cached_tokens:2},total_tokens:11});
export const chatDoc = () => ({id:'fixture_123',model:'fixture/'+model,object:'chat.completion',
    choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:answer}}],usage:usage()});
export const chatToolDoc = () => ({id:'fixture_456',model:'fixture/'+model,object:'chat.completion',
    choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,
        tool_calls:[{index:0,id:'call_fixture_1',type:'function',function:{name:tool,arguments:toolArguments}}]}}],usage:usage()});
function eventsOf(result) {
    const raw=responsesEvents(result);
    const events=raw.trimEnd().split('\n\n').map(block=>JSON.parse(block.split('\n')[1].slice(6)));
    events.at(-1).response.usage.input_tokens_details={cached_tokens:2};
    return events;
}
export const responseTextEvents = () => eventsOf({id:'fixture_123',model:'fixture/'+model,content:answer,toolCalls:[],usage:{prompt_tokens:8,completion_tokens:3}});
export const responseToolEvents = () => eventsOf({id:'fixture_456',model:'fixture/'+model,content:'',
    toolCalls:[{id:'call_fixture_1',name:tool,arguments:toolArguments}],usage:{prompt_tokens:8,completion_tokens:3}});
export const encode = events => events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join('');
export const upstream = (body,media='application/json') => new Response(body,{headers:{'content-type':media}});
