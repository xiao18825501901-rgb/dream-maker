/* Offline-only test bundle; dynamic loading of ESM modules in about:blank. Never ships in the public site. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const names=['contracts','dom','demo-api','local-api','siwc-local','views','preview','ui'];
let result='const __testModules={};\n';
for(const n of names){let js=readFileSync(resolve(root,'dist/web',n+'.js'),'utf8');const exported=[...js.matchAll(/export (?:async )?(?:class|function|const|let)\s+(\w+)/g)].map(x=>x[1]);
js=js.replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)\.js['"];?/g,(_m,x,y)=>'const {'+x.replace(/\bas\b/g,':')+'}=__testModules["'+y+'"];');
js=js.replace(/\bexport\s+(?=(?:async\s+)?(?:class|function|const|let)\b)/g,'');
if(/^\s*(?:import|export)\b/m.test(js))throw Error('UNSUPPORTED_MODULE:'+n);
result+='__testModules["'+n+'"]=(()=>{\n'+js+'\nreturn {'+exported.join(',')+'};})();\n';
}
result+='window.siwcDomModules=__testModules;';
const out=resolve(root,'docs/siwc/evidence');mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'offline-dom-bundle.js'),result);console.log('SIWC local-only offline bundle created. No network and no OAuth.');
