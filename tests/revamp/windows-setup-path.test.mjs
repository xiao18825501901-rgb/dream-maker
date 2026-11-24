// Real existing C# compiler + production parser via reflection. Never invokes Setup.Main,
// extracts a payload, installs a product, reads credentials or launches an agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('compiled Setup ZIP parser rejects device aliases, ADS and trailing aliases before extraction',t=>{
 const parent=resolve('.runtime/test-temp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(join(parent,'setup-path-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const compiler=join(process.env.SystemRoot??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 const assembly=join(dir,'setup-parser.dll'),probe=join(dir,'parser-probe.cs'),exe=join(dir,'parser-probe.exe');
 const run=(file,args)=>spawnSync(file,args,{encoding:'utf8',windowsHide:true,timeout:60000});
 let result=run(compiler,['/nologo','/target:library','/reference:System.dll','/reference:System.Core.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll','/out:'+assembly,resolve('scripts/revamp/windows-setup-bootstrapper.cs')]);assert.equal(result.status,0,result.stdout+result.stderr);
 writeFileSync(probe,`using System; using System.Reflection; using System.Text;
class ParserProbe { static int Main(string[] args) {
 var method=Assembly.LoadFile(args[0]).GetType("DreamMakerSetup").GetMethod("SafeEntryName",BindingFlags.NonPublic|BindingFlags.Static);
 for(int i=1;i<args.Length;i++) { bool reject=args[i][0]=='R'; string value=Encoding.UTF8.GetString(Convert.FromBase64String(args[i].Substring(2)));
  try { var actual=(string)method.Invoke(null,new object[]{value}); if(reject||actual!=value.TrimEnd('/')){Console.Error.WriteLine("UNEXPECTED_ACCEPTANCE:"+i);return 1;} }
  catch(TargetInvocationException e){if(!reject||e.InnerException.GetType().Name!="SetupFailure"||(string)e.InnerException.GetType().GetField("Code",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(e.InnerException)!="SETUP_ZIP_PATH_INVALID"){Console.Error.WriteLine("UNEXPECTED_REJECTION:"+i);return 1;}}
 } Console.WriteLine("PASS_COMPILED_SETUP_PATHS:"+(args.Length-1)); return 0; }}
`);
 result=run(compiler,['/nologo','/target:exe','/reference:System.dll','/out:'+exe,probe]);assert.equal(result.status,0,result.stdout+result.stderr);
 const accepted=['core/app/main.js','COM10.log','COM0.txt','conifer/file.js','许可/说明.txt','dir/'];
 const rejected=['core/NUL.txt','CON','components/COM¹.log','LPT³.txt','CONIN$.txt','CONOUT$','x/payload:stream','x/trailing.','x/trailing ','a//b','../x','x/\u0001bad'];
 const cases=[...accepted.map(v=>'A:'+Buffer.from(v).toString('base64')),...rejected.map(v=>'R:'+Buffer.from(v).toString('base64'))];
 result=run(exe,[assembly,...cases]);assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS_COMPILED_SETUP_PATHS:18/);
});
