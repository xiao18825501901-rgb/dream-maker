// OFFLINE EventSource protocol seam, no browser/process/model qualification.
import test from 'node:test';import assert from 'node:assert/strict';
import {LocalApiAdapter} from '../../dist/web/local-api.js';
test('a fixed application-stopping event closes the subscription without retrying a task',t=>{
 const old=globalThis.EventSource;let stream,events=0;const states=[];
 globalThis.EventSource=class{listeners=new Map();closed=0;constructor(){stream=this;}addEventListener(k,fn){this.listeners.set(k,fn);}close(){this.closed++;}};t.after(()=>globalThis.EventSource=old);
 const adapter=new LocalApiAdapter(),stop=adapter.subscribe('p1',()=>events++,s=>states.push(s));
 stream.listeners.get('application-stopping')?.({data:'{"reason":"APPLICATION_STOPPING"}'});assert.equal(stream.closed,1);assert.equal(states.at(-1),'closed');stream.onopen();stream.onerror();stop();adapter.dispose();assert.equal(stream.closed,1);assert.equal(events,0);assert.equal(states.at(-1),'closed');
});
test('malformed stopping metadata cannot suppress ordinary network recovery',t=>{
 const old=globalThis.EventSource;let stream;const states=[];globalThis.EventSource=class{listeners=new Map();closed=0;constructor(){stream=this;}addEventListener(k,fn){this.listeners.set(k,fn);}close(){this.closed++;}};t.after(()=>globalThis.EventSource=old);
 const adapter=new LocalApiAdapter(),stop=adapter.subscribe('p1',()=>{},s=>states.push(s));for(const data of ['{bad','{"reason":"OTHER"}','{"reason":"APPLICATION_STOPPING","success":true}'])stream.listeners.get('application-stopping')?.({data});assert.equal(stream.closed,0);stream.onerror();assert.equal(states.at(-1),'reconnecting');stop();
});
