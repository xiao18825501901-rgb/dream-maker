import {DomainError,hash,object} from './security.js';
import type {SqliteRetirementBasis} from './sqlite-retirement.js';
export type RetirementBinding=Pick<SqliteRetirementBasis,'jobId'|'authorityHash'|'resourceHelperHash'>;
export interface RetirementObservation {schema:string;attempt:Record<string,unknown>;helperAbsent:true;outcome:null|{schema:string;attemptId:string;authorityHash:string;attemptHash:string;status:'RETIRED'|'FAILED';result:Record<string,unknown>|null;errorCode:string|null}}
const keys=(v:Record<string,unknown>,names:string)=>Object.keys(v).sort().join(' ')==names.split(' ').sort().join(' ');
/** Called on a fresh fixed-program read after owned root closure, never on model output. */
export function checkRetirementObservation(raw:unknown,b:RetirementBinding,attemptId:string,helperHash:string):RetirementObservation{
 try{
  const v=object(raw),a=object(v.attempt),identity=object(a.identity);
  if(!keys(v,'schema attempt helperAbsent outcome')||v.schema!=='dream-maker.sqlite-retirement-observation.v1'||v.helperAbsent!==true||
   !keys(a,'schema attemptId jobId authorityHash helperHash resourceHelperHash bootId identity')||a.schema!=='dream-maker.sqlite-retirement-attempt.v1'||a.attemptId!==attemptId||a.jobId!==b.jobId||a.authorityHash!==b.authorityHash||a.helperHash!==helperHash||a.resourceHelperHash!==b.resourceHelperHash||
   typeof a.bootId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(a.bootId)||!keys(identity,'pid startTicks')||!Number.isSafeInteger(identity.pid)||Number(identity.pid)<=1||typeof identity.startTicks!=='string'||!/^\d{1,20}$/.test(identity.startTicks)||identity.startTicks==='0')throw Error();
  if(v.outcome!==null){
   const o=object(v.outcome);
   if(!keys(o,'schema attemptId authorityHash attemptHash status result errorCode')||o.schema!=='dream-maker.sqlite-retirement-outcome.v1'||o.attemptId!==attemptId||o.authorityHash!==b.authorityHash||o.attemptHash!==hash(a))throw Error();
   if(o.status==='RETIRED'){
    const r=object(o.result);if(!keys(r,'schema jobId authorityHash retired containerBytesAfter reservationReleased replayed evidencePreserved')||r.schema!=='dream-maker.sqlite-retirement-result.v1'||r.jobId!==b.jobId||r.authorityHash!==b.authorityHash||r.retired!==true||r.containerBytesAfter!==0||r.reservationReleased!==true||r.evidencePreserved!==true||typeof r.replayed!=='boolean'||o.errorCode!==null)throw Error();
   }else if(o.status!=='FAILED'||o.result!==null||typeof o.errorCode!=='string'||!/^SQLITE_RETIREMENT_[A-Z_]{1,80}$/.test(o.errorCode))throw Error();
  }
  return v as unknown as RetirementObservation;
 }catch{throw new DomainError('SQLITE_RETIREMENT_CLEANUP_UNPROVEN',502);}
}
/** Literal source pins precede any metadata parsing or execution. stdin stays open for cancellation. */
export function retirementBootstrap(helperHash:string,resourceHash:string,mode:'run'|'read'):string{
 if(![helperHash,resourceHash].every(v=>/^[a-f0-9]{64}$/.test(v))||!['run','read'].includes(mode))throw new DomainError('SQLITE_RETIREMENT_PROGRAM_PIN_INVALID',409);
 return `import os,sys,json,hashlib,select,signal,time
raw=bytearray()
while True:
 part=os.read(0,65536)
 if not part: raise RuntimeError('SQLITE_RETIREMENT_INPUT_TRUNCATED')
 end=part.find(b'\\n');raw.extend(part if end<0 else part[:end])
 if len(raw)>262144: raise RuntimeError('SQLITE_RETIREMENT_INPUT_LIMIT')
 if end>=0:
  if part[end+1:]: raise RuntimeError('SQLITE_RETIREMENT_TRAILING_INPUT')
  break
def unique(pairs):
 value={}
 for key,item in pairs:
  if key in value: raise RuntimeError('SQLITE_RETIREMENT_DUPLICATE_KEY')
  value[key]=item
 return value
v=json.loads(raw,object_pairs_hook=unique)
if not isinstance(v,dict) or set(v)!={'schema','program','resourceProgram','request'} or v['schema']!='dream-maker.sqlite-retirement-input.v1': raise RuntimeError('SQLITE_RETIREMENT_INPUT_INVALID')
if not isinstance(v['program'],str) or hashlib.sha256(v['program'].encode()).hexdigest()!='${helperHash}' or not isinstance(v['resourceProgram'],str) or hashlib.sha256(v['resourceProgram'].encode()).hexdigest()!='${resourceHash}': raise RuntimeError('SQLITE_RETIREMENT_SOURCE_CHANGED')
q=v['request']
if not isinstance(q,dict) or set(q)!={'basis','attemptId'}: raise RuntimeError('SQLITE_RETIREMENT_REQUEST_INVALID')
n={'__name__':'trusted_retirement'};exec(compile(v['program'],'<fixed-retirement>','exec'),n)
b=n['basis_checked'](q['basis'])
if b['resourceHelperHash']!='${resourceHash}': raise RuntimeError('SQLITE_RETIREMENT_RESOURCE_SOURCE_CHANGED')
if '${mode}'=='read':
 result=n['read_retirement_state'](b,q['attemptId'],'${helperHash}')
else:
 resources={'__name__':'trusted_resource_reader'};exec(compile(v['resourceProgram'],'<fixed-resource-reader>','exec'),resources)
 stopping=False;deadline=time.monotonic()+45
 def stop(*args):
  global stopping
  stopping=True
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 def cancelled():
  global stopping
  if not stopping and select.select([0],[],[],0)[0]:
   os.read(0,1);stopping=True
  return stopping or time.monotonic()>=deadline
 result=n['execute_retirement'](b,q['attemptId'],'${helperHash}',resources['read_resource_job'],parent_gone=cancelled)
output=n['canonical'](result)
if len(output)>16384: raise RuntimeError('SQLITE_RETIREMENT_OUTPUT_LIMIT')
sys.stdout.buffer.write(output+b'\\n');sys.stdout.buffer.flush()
if '${mode}'=='run' and result['status']!='RETIRED': raise SystemExit(7)
`;
}
