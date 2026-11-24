import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createReviewServer} from './serve-frontend-review.mjs';
const suite='F:/DreamMakerSuite',receipt=join(suite,'runtime/frontend-tour-session.json');
const {chromium}=await import(pathToFileURL(join(suite,'runtime/browser-tools/node_modules/playwright/index.mjs')).href);
let dm,df,context;
const startedAt=new Date().toISOString();
const save=status=>writeFile(receipt,JSON.stringify({status,kind:'USER_FRONTEND_TOUR_SYNTHETIC_NOT_LIVE',pid:process.pid,startedAt,changedAt:new Date().toISOString(),cwd:process.cwd(),worktree:'F:/DreamMakerSuite/worktrees/kimi-p1-v1',urls:{dreamMaker:dm?.url,dreamFlow:df?.url},profile:join(suite,'runtime/browser-profiles/frontend-tour-user'),downloads:join(suite,'data/FrontendTourDownloads'),paidModelCalls:0,controllerApi:false,userFrontendConfirmed:false},null,2));
try{
 dm=await createReviewServer({product:'dream-maker',port:4328});df=await createReviewServer({product:'dreamflow',port:4329});
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','SYSTEMROOT','WINDIR','COMSPEC','SYSTEMDRIVE','PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA','USERPROFILE'].includes(key.toUpperCase())));
 Object.assign(env,{TEMP:join(suite,'temp'),TMP:join(suite,'temp'),TMPDIR:join(suite,'temp')});
 await mkdir(join(suite,'runtime/browser-profiles'),{recursive:true});
 context=await chromium.launchPersistentContext(join(suite,'runtime/browser-profiles/frontend-tour-user'),{executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:false,viewport:null,downloadsPath:join(suite,'data/FrontendTourDownloads'),args:['--disable-background-networking','--no-first-run','--disk-cache-dir='+join(suite,'caches/browser-tour'),'--window-size=1460,1000'],env});
 const local=new Set([new URL(dm.url).origin,new URL(df.url).origin]);
 await context.route('**/*',route=>local.has(new URL(route.request().url()).origin)?route.continue():route.abort());
 const maker=context.pages()[0]??await context.newPage();await maker.goto(dm.url,{waitUntil:'networkidle'});
 const flow=await context.newPage();await flow.goto(df.url,{waitUntil:'networkidle'});await maker.bringToFront();
 await save('OPEN');console.log(JSON.stringify({pid:process.pid,dreamMaker:dm.url,dreamFlow:df.url,profile:'F_DRIVE_USER_ONLY_NO_TEST_SESSION',kind:'FRONTEND_REVIEW_ONLY'}));
 await new Promise(resolve=>context.once('close',resolve));
}catch(error){console.error(String(error));process.exitCode=1;}
finally{await context?.close().catch(()=>{});await dm?.close();await df?.close();await save('CLOSED');}
