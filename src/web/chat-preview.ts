import { mountChatShell } from './chat-shell.js';
import { createChatDemo } from './chat-demo.js';
const root=document.getElementById('app')!;
let view:ReturnType<typeof mountChatShell>;
const demo=createChatDemo(state=>view.render(state));
view=mountChatShell(root,demo);demo.start();
window.addEventListener('pagehide',()=>{demo.dispose();view.destroy();},{once:true});
