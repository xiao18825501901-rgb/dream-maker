import { statusRail } from '../../dist/web/views.js';
const base = { mode:'local', screen:'project', projects:[], settings:null, tab:'work', busy:false, error:'', events:[], connection:'connected', railClosed:false };
const withStatus = status => ({ ...base, snapshot: { project:{id:'p',name:'n',state:'DRAFT',answers:[]}, spec:null, runs:[], records:[], status } });
const admissionBlocked = { state:'OFF', allowsSend:false, reason:'KIMI_EXTRA_USAGE_UNKNOWN' };
const admissionAllowed = { state:'OFF', allowsSend:true, reason:'OK' };
const credentialsOk = { barrier:'READY', state:'OK', generation:7, reason:null, expiresAt:null, savedAtMs:null };
const cases = {
  noStatus: statusRail({ ...base, snapshot: { project:{id:'p'}, spec:null, runs:[], records:[] } }),
  blockedByGate: statusRail(withStatus({ kimi:{ admission:admissionBlocked, credentials:credentialsOk, inferenceAllowed:false, note:'KIMI_EXTRA_USAGE_UNKNOWN', lastAuthFailure:null }, laya:{ turns:0, fullyOff:false, reason:'NO_TURNS_OBSERVED' }, shadow:{ mode:'OFF', requested:'OFF', degraded:false } })),
  allowed: statusRail(withStatus({ kimi:{ admission:admissionAllowed, credentials:credentialsOk, inferenceAllowed:true, note:'OK', lastAuthFailure:null }, laya:{ turns:4, fullyOff:true, reason:'OK' }, shadow:{ mode:'SHADOW', requested:'SHADOW', degraded:false, recent:['role.dispatch','shadow.pass'] } })),
  rejected: statusRail(withStatus({ kimi:{ admission:admissionAllowed, credentials:credentialsOk, inferenceAllowed:true, note:'KIMI_GRANT_REJECTED_AT_RUNTIME', lastAuthFailure:{ class:'REAUTH_REQUIRED', layer:'L3_OAUTH', code:'KIMI_REAUTH_REQUIRED', atMs:1 } }, laya:{ turns:1, fullyOff:true, reason:'OK' }, shadow:{ mode:'OFF', requested:'OFF', degraded:false } })),
  degraded: statusRail(withStatus({ kimi:{ admission:admissionAllowed, credentials:credentialsOk, inferenceAllowed:true, note:'OK', lastAuthFailure:null }, laya:{ turns:1, fullyOff:true, reason:'OK' }, shadow:{ mode:'OFF', requested:'MANAGED', degraded:true, reason:'ORCA_MODE_NOT_AVAILABLE' } }))
};
const results = [];
const check = (name, ok) => { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name); };
check('EMPTY_WHEN_NO_STATUS', cases.noStatus === '');
// A raw code is not a sentence: the rail must show the tested wording instead.
check('BLOCKED_SHOWS_FRIENDLY_WORDING', cases.blockedByGate.includes('Extra Usage 状态未确认'));
check('BLOCKED_HIDES_RAW_CODE', !cases.blockedByGate.includes('KIMI_EXTRA_USAGE_UNKNOWN'));
check('BLOCKED_NO_LOGIN_PROMPT', !/请重新登录|需要本人授权/.test(cases.blockedByGate));
check('ALLOWED_SHOWS_OK', cases.allowed.includes('可以推理'));
check('LAYA_PROVEN', cases.allowed.includes('OFF 已证'));
check('SHADOW_MODE', cases.allowed.includes('SHADOW'));
check('SHADOW_RECENT', cases.allowed.includes('role.dispatch') && cases.allowed.includes('shadow.pass'));
check('HAS_RAIL_IDS', cases.allowed.includes('data-rail="kimi"') && cases.allowed.includes('data-rail="laya"') && cases.allowed.includes('data-rail="shadow"'));
// A proven runtime rejection outranks "can reason", and only then may the rail mention authorisation.
check('REJECTION_NOT_RENDERED_AS_HEALTHY', !cases.rejected.includes('可以推理') && cases.rejected.includes('服务端已拒绝'));
check('REJECTION_MARKS_AUTHORISATION', cases.rejected.includes('需本人授权'));
// A requested-but-unavailable Orca mode must be visible on the project page too.
check('DEGRADED_MODE_VISIBLE', cases.degraded.includes('已降级') && cases.degraded.includes('MANAGED'));
const failed = results.filter(r => !r.ok);
console.log('RAIL_CHECK ' + (failed.length === 0 ? 'OK' : 'FAILED') + ' ' + results.length + ' checks');
if (failed.length > 0) process.exitCode = 1;
