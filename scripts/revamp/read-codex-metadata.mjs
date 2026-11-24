// Actual independent app-server inventory; no thread/start, turn/start, login or credential transfer.
import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readCodexMetadata } from '../../dist/server/providers/codex-status.js';
import { parseConfig } from '../../dist/server/config.js';
import { ClashService } from '../../dist/server/clash-service.js';
import { within } from '../../dist/server/security.js';
const root=fileURLToPath(new URL('../..',import.meta.url));
const config=parseConfig(JSON.parse(readFileSync(resolve(root,'config/local.json'),'utf8')));
const output=within(root,'.runtime/revamp-20261101/codex-metadata-'+new Date().toISOString().replace(/[^0-9T]/g,''));
mkdirSync(output,{recursive:false,mode:0o700});
const clash=new ClashService(()=>config,within(root,'.runtime/revamp-20261101/clash-metadata-route'));
const report=config.clash.enabled
    ?await clash.withRun('codex-metadata-inventory',AbortSignal.timeout(60000),()=>readCodexMetadata(config,root,extra=>clash.childEnvironment(extra)))
    :await readCodexMetadata(config,root);
writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,accountType:report.account.type,configuredModelListed:report.configuredModelListed,quota:report.quota,errors:report.errors,modelTurnsRequested:0,cleanupReturned:report.cleanupReturned}));
