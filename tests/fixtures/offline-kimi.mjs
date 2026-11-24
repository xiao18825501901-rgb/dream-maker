// Explicit test runner only: no account, provider, fee or Native qualification.
import { createKimiAdmission } from '../../dist/server/kimi-admission.js';
import { hash } from '../../dist/server/security.js';

export function offlineKimi(workspace, complete) {
 return {
  workspace, instructions: '',
  admission: createKimiAdmission({schema:1,state:'OFF',source:'USER_ATTESTED',accountRef:'kimi:OFFLINE_TEST',observedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()}),
  runner: {async run(input) {
   const result=await complete(JSON.parse(input.prompt),input.signal),text=JSON.stringify(result.data);
   return {text,sessionId:'OFFLINE_TEST_SESSION',usage:{...result.usage,source:'OFFLINE_TEST'},receipt:{turnId:'OFFLINE_TEST_TURN',reason:'completed',answerChars:text.length,answerHash:hash(text)}};
  }}
 };
}
