import {responsesEvents} from '../../dist/server/flow/responses-wire.js';
export const model = 'fixture-chat-only';
export const prompt = 'DreamFlow frozen synthetic role packet';
export const answer = 'fixture completion 你好';
export const instructions = 'Use only this frozen review packet.';
export function context(protocol='chat-completions',role='reviewer') {
    const route = {runtime:'claude',provider:'fixture',protocol,model,authentication:'api_key',authRef:'offline_auth',accountRef:'offline_account',upstreamAccountRef:'fixture/offline_peer'};
    return {route,role,accounts:[{...route,capabilities:[{model,protocol}]}],limits:{model,prompt,instructions,maxInputTokens:64,maxOutputTokens:512},
        assertCurrent(){},assertSafe(){},signal:new AbortController().signal};
}
export function requestBody() {
    const cc={type:'ephemeral'};
    return {model,messages:[{role:'user',content:[{type:'text',text:prompt,cache_control:cc}]}],system:[{type:'text',text:'LOCAL_ONLY'}],tools:[],
        metadata:{user_id:'LOCAL_ONLY'},max_tokens:512,output_config:{effort:'high'},stream:true};
}
export const ingress = body => ({method:'POST',path:'/v1/messages?beta=true',contentType:'application/json',version:'2023-06-01',body:typeof body==='string'?body:JSON.stringify(body)});
export const chatDoc = () => ({id:'fixture_123',model:'fixture/'+model,object:'chat.completion',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:answer}}],
    usage:{prompt_tokens:8,completion_tokens:3,prompt_tokens_details:{cached_tokens:2},total_tokens:11}});
export function responseEvents() {
    const raw=responsesEvents({id:'fixture_123',model:'fixture/'+model,content:answer,toolCalls:[],usage:{prompt_tokens:8,completion_tokens:3}});
    const events=raw.trimEnd().split('\n\n').map(block=>JSON.parse(block.split('\n')[1].slice(6)));
    events.at(-1).response.usage.input_tokens_details={cached_tokens:2};
    return events;
}
export const encode = events => events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join('');
export const upstream = (body,media='application/json') => new Response(body,{headers:{'content-type':media}});
