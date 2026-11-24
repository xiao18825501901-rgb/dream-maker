/** Test-only module loader. Converts our named ESM modules to isolated closures for DOM tests on about:blank.
 * No network is proxied; never use this to work around a browser navigation restriction. */
import { readFileSync,writeFileSync,mkdirSync,lstatSync } from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const names=[],modules=new Map(),visiting=new Set();
const MAX_MODULES=64;
const MAX_BUNDLE_BYTES=8*1024*1024;
const SHARED_MODULES=new Set(['demo-tasks','network-contexts','codex-metadata','role-names','custom-magpie-protocol']);
const importPattern=/import\s*\{[^}]+\}\s*from\s*['"]([^'"]+)['"];?/g;
function dependency(from,specifier){
 if(!from.startsWith('shared/')&&/^\.\/[a-z][a-z0-9-]*\.js$/.test(specifier))return specifier.slice(2,-3);
 if(!from.startsWith('shared/')&&specifier.startsWith('../shared/')&&specifier.endsWith('.js')&&SHARED_MODULES.has(specifier.slice(10,-3)))return 'shared/'+specifier.slice(10,-3);
 throw Error('OFFLINE_MODULE_IMPORT_DENIED');
}
function visit(name){
 if(!/^[a-z][a-z0-9-]*$/.test(name)&&!(name.startsWith('shared/')&&SHARED_MODULES.has(name.slice(7))))throw Error('OFFLINE_MODULE_NAME_DENIED');
 if(visiting.has(name))throw Error('OFFLINE_MODULE_CYCLE');
 if(modules.has(name))return;
 if(modules.size+visiting.size>=MAX_MODULES)throw Error('OFFLINE_MODULE_LIMIT');
 const path=resolve(root,name.startsWith('shared/')?'dist':'dist/web',name+'.js');
 if(lstatSync(path).isSymbolicLink())throw Error('OFFLINE_MODULE_LINK_DENIED');
 const source=readFileSync(path,'utf8');if(Buffer.byteLength(source)>200000)throw Error('OFFLINE_MODULE_SIZE_LIMIT');
 visiting.add(name);
 for(const match of source.matchAll(importPattern))visit(dependency(name,match[1]));
 visiting.delete(name);modules.set(name,source);names.push(name);
}
for(const name of ['ui','demo-api','local-api'])visit(name);
let out='/* OFFLINE DOM TEST ONLY. NOT DEPLOYED. */\nconst __uiModules={};\n';
for(const n of names){
 let text=modules.get(n);
 const exports=[...text.matchAll(/export (?:async )?(?:class|function|const|let)\s+(\w+)/g)].map(m=>m[1]);
 text=text.replace(/export\s*\{([^}]+)\}\s*;/g,(_,bindings)=>{
  for(const name of bindings.split(',').map(value=>value.trim()).filter(Boolean)){
   if(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))throw Error('OFFLINE_EXPORT_BINDING_DENIED');
   exports.push(name);
  }
  return '';
 });
 text=text.replace(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g,(_,bindings,specifier)=>'const {'+bindings.replace(/\bas\b/g,':')+"}=__uiModules['"+dependency(n,specifier)+"'];");
 text=text.replace(/\bexport\s+(?=(?:async\s+)?(?:class|function|const|let)\b)/g,'');
 if(/^\s*(?:import|export)\b/m.test(text))throw Error('Unsupported module syntax in '+n);
 out+="__uiModules['"+n+"']=(()=>{\n"+text+'\nreturn {'+exports.join(',')+'};})();\n';
}
out+=`window.dmTest={modules:__uiModules, async start(){this.adapter=new __uiModules['demo-api'].DemoScenarioAdapter();this.ui=new __uiModules.ui.DreamMakerUI(this.adapter);await this.ui.boot();}, async restart(){this.ui.dispose();this.adapter=new __uiModules['demo-api'].DemoScenarioAdapter();this.ui=new __uiModules.ui.DreamMakerUI(this.adapter);await this.ui.boot();}};\n`;
if(Buffer.byteLength(out)>MAX_BUNDLE_BYTES)throw Error('OFFLINE_BUNDLE_SIZE_LIMIT');
mkdirSync(resolve(root,'.runtime/ui-offline'),{recursive:true});
writeFileSync(resolve(root,'.runtime/ui-offline/offline-test-bundle.js'),out);
console.log('Created non-publishable offline DOM test bundle. No browsing capabilities altered.');
