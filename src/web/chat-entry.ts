import { mountChatShell } from './chat-shell.js';
import { ChatLiveController } from './chat-controller.js';

const legacy=new URLSearchParams(location.search).get('ui')==='legacy';
if(legacy){
 for(const href of ['/style.css','/tokens.css','/base.css','/hallmark.css']){const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);}
 document.getElementById('chat-style')?.remove();
 if(document.documentElement.dataset.product==='dreamflow')void import('./dreamflow-app.js');else void import('./app.js');
}else{
 const root=document.getElementById('app')!;
 let view:ReturnType<typeof mountChatShell>;
 const controller=new ChatLiveController(state=>view.render(state));
 view=mountChatShell(root,controller);view.render(controller.state);void controller.boot();
 window.addEventListener('pagehide',()=>{controller.dispose();view.destroy();},{once:true});
 // A back/forward-cache restore must reconnect, never show a disposed stale controller.
 window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
}
