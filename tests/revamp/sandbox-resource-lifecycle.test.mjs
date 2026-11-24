import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';
import * as boundary from '../../dist/server/sandbox-resource.js';
// Offline counterexamples only; fixtures never attest product process cleanup.
test('a broken worker output flush still exits the fork without entering parent cleanup',()=>{
 const py=String.raw`import ast,pathlib,sys,types
src=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'));f=[n for n in src.body if isinstance(n,ast.FunctionDef) and n.name=='exit_worker_child'];assert len(f)==1,'MISSING_UNCONDITIONAL_CHILD_EXIT'
class Exit(BaseException):pass
class Output:
 def __init__(self,broken):self.broken=broken
 def flush(self):
  if self.broken:raise BrokenPipeError('synthetic')
for first in [True,False]:
 calls=[]
 def leave(code):calls.append(code);raise Exit()
 ns={'os':types.SimpleNamespace(_exit=leave),'sys':types.SimpleNamespace(stdout=Output(first),stderr=Output(not first))};exec(compile(ast.Module(body=f,type_ignores=[]),'<child-exit>','exec'),ns)
 try:ns['exit_worker_child'](0);raise AssertionError('returned into parent')
 except Exit:pass
 assert calls==[7]
print('CHILD_ALWAYS_EXITS')`;
 const r=spawnSync('python',['-I','-c',py,resolve('scripts/isolation/wsl-resource-context.py')],{encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/CHILD_ALWAYS_EXITS/);
});
test('status pipe EOF switches to bounded waiting instead of a busy select loop',()=>{
 const py=String.raw`import ast,pathlib,sys,types
f=[n for n in ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')).body if isinstance(n,ast.FunctionDef) and n.name=='wait_worker'];assert len(f)==1,'MISSING_EOF_AWARE_WAIT'
calls={'wait':0,'select':0,'sleep':0};parts=[b'{}',b'']
def wait(pid,flags):
 calls['wait']+=1;return (pid,0) if calls['wait']==5 else (0,0)
def select(read,write,errors,seconds):calls['select']+=1;return read,[],[]
def sleep(seconds):assert seconds>=.01;calls['sleep']+=1
ns={'os':types.SimpleNamespace(waitpid=wait,WNOHANG=1,read=lambda fd,n:parts.pop(0)),'select':types.SimpleNamespace(select=select),'time':types.SimpleNamespace(monotonic=lambda:0,sleep=sleep)};exec(compile(ast.Module(body=f,type_ignores=[]),'<owner-wait>','exec'),ns)
assert ns['wait_worker'](123,4,100,lambda:False)==(0,b'{}');assert calls['select']==2 and calls['sleep']>=3
print('WAIT_BOUNDED_AFTER_EOF')`;
 const r=spawnSync('python',['-I','-c',py,resolve('scripts/isolation/wsl-resource-context.py')],{encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/WAIT_BOUNDED_AFTER_EOF/);
});
test('recovery requires the original Windows process start identity and ordered root close',()=>{
 assert.equal(typeof boundary.requireResourceProcessClosure,'function');
 const pid='owned_1',generation='owner_1',rows=[{id:'1',kind:'OwnedProcessRootStarted',data:{processId:pid,generation,pid:123,identity:'win32:456'}},{id:'2',kind:'OwnedProcessRootExited',data:{processId:pid,generation,rootClosed:true,code:0,signal:null}}];
 assert.equal(boundary.requireResourceProcessClosure(rows,pid,generation).identity,'win32:456');
 for(const bad of [rows.slice(0,1),rows.slice(1),rows.toReversed(),[rows[0],rows[1],rows[1]],[{...rows[0],data:{...rows[0].data,identity:null}},rows[1]],[rows[0],{...rows[1],data:{...rows[1].data,generation:'other'}}]])assert.throws(()=>boundary.requireResourceProcessClosure(bad,pid,generation),{code:'SANDBOX_RESOURCE_CLEANUP_UNPROVEN'});
});
