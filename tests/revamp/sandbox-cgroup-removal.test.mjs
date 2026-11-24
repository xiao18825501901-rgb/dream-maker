// Deterministic kernel-busy/remaining-thread counterexamples; not actual OS acceptance.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';
for(const [path,method,code] of [['wsl-worker.py','remove_quiescent_group','CGROUP_REMOVE_UNPROVEN'],['wsl-resource-context.py','remove_empty','RESOURCE_GROUP_REMOVE_UNPROVEN']])test(method+' retries a busy empty cgroup but never removes remaining kernel tasks',()=>{
 const py=String.raw`import pathlib,sys,errno,ast,time
ns={'errno':errno,'time':time};src=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8');f=[n for n in ast.parse(src).body if isinstance(n,ast.FunctionDef) and n.name==sys.argv[2]];assert len(f)==1,'MISSING_QUIESCENT_REMOVAL';exec(compile(ast.Module(body=f,type_ignores=[]),'<fixed-worker-function>','exec'),ns)
class Entry:
 def __init__(self,value):self.value=value
 def read_text(self):return self.value
class Group:
 def __init__(self,busy=False):self.calls=0;self.busy=busy
 def __truediv__(self,key):return Entry('99' if self.busy and key=='cgroup.threads' else 'populated 0' if key=='cgroup.events' else '')
 def rmdir(self):
  self.calls+=1
  if self.calls==1:raise OSError(errno.EBUSY,'synthetic kernel reap pending')
g=Group();ns[sys.argv[2]](g);assert g.calls==2
g=Group(True)
try:ns[sys.argv[2]](g);raise AssertionError('live threads accepted')
except RuntimeError as e:assert str(e)==sys.argv[3]
assert g.calls==0
print('TWO_BOUNDARIES_VERIFIED')`;
 const r=spawnSync('python',['-I','-c',py,resolve('scripts/isolation',path),method,code],{encoding:'utf8',windowsHide:true,timeout:6000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/TWO_BOUNDARIES_VERIFIED/);
});
