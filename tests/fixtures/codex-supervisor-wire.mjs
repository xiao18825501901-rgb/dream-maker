// Shared offline fixtures for the Codex read-only Messages lane. Every string is synthetic.
export const model = 'fixture-messages-only';
export const prompt = 'DreamFlow frozen synthetic role packet';
export const answer = 'fixture completion 你好';
export const instructions = 'Use only this frozen review packet.';
export const messageId = 'msg_fixture_1';

export function context(role = 'reviewer') {
    const route = {runtime:'codex',provider:'fixture',protocol:'anthropic-messages',model,authentication:'api_key',
        authRef:'offline_auth',accountRef:'offline_account',upstreamAccountRef:'fixture/offline_peer'};
    return {route,role,accounts:[{...route,capabilities:[{model,protocol:'anthropic-messages'}]}],
        limits:{model,instructions,maxInputTokens:64,maxOutputTokens:512},
        prompt:() => prompt,assertCurrent(){},assertSafe(){},signal:new AbortController().signal};
}

/** One frozen Codex turn as the pinned CLI posts it: no tool, one user text, one system text. */
export function requestBody() {
    return {model,store:false,stream:true,max_output_tokens:1024,tools:[],tool_choice:'auto',parallel_tool_calls:false,
        instructions:'LOCAL_ONLY CLI text',include:['reasoning.encrypted_content'],reasoning:{effort:'medium'},
        prompt_cache_key:'synthetic-cache-key',client_metadata:{session_id:'synthetic'},
        text:{format:{type:'json_schema',name:'plan',strict:true,schema:{type:'object',properties:{verdict:{type:'string'}}}}},
        input:[{type:'additional_tools',role:'developer',id:'synthetic_tools',tools:[{type:'namespace',name:'desk'}]},
            {type:'message',role:'system',content:[{type:'input_text',text:'LOCAL_ONLY CLI policy'}]},
            {type:'message',role:'user',content:[{type:'input_text',text:prompt}]}]};
}

export const ingress = body => ({method:'POST',path:'/v1/responses',contentType:'application/json',
    body:typeof body === 'string' ? body : JSON.stringify(body)});

/** The upstream Messages transcript: one closed text block, no cache write. */
export function messageEvents() {
    return [
        {type:'message_start',message:{id:messageId,type:'message',role:'assistant',model:'fixture/'+model,content:[],
            stop_reason:null,stop_sequence:null,
            usage:{input_tokens:6,cache_read_input_tokens:2,cache_creation_input_tokens:0,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:answer.slice(0,7)}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:answer.slice(7)}},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}},
        {type:'message_stop'},
    ];
}
export const encode = events => events.map(e => 'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join('');
export const upstream = (body,media = 'text/event-stream') => new Response(body,{headers:{'content-type':media}});
