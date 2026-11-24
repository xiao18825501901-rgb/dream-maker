import {DomainError} from './security.js';

const edgeImage=/^(?:msedge)(?:\.exe)?$/i;
const externalTermination=/\b(?:taskkill|stop-process|terminateprocess|terminate-process|pkill|killall)\b/i;
const edgeToken=/\bmsedge(?:\.exe)?\b/i;

function deny():never{
    throw new DomainError('EDGE_PROCESS_PRESERVATION_REQUIRED',409,'Dream Maker may not launch Microsoft Edge or run external process-termination tools from an owned command.');
}

/** Process-launch policy for DM-owned children. Read-only external diagnostics stay outside this API. */
export function assertNotProtectedProcess(command:string,args:string[]):void{
    if(typeof command!=='string'||!Array.isArray(args)||args.some(arg=>typeof arg!=='string'))deny();
    const image=command.split(/[\\/]/).at(-1)??'';
    if(edgeImage.test(image))deny();
    const text=[image,...args].join(' ');
    if(edgeToken.test(text)||externalTermination.test(text))deny();
}
