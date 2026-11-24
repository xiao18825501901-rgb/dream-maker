/** Historical local process check; this grants no account, model, routing or execution authority. */
export interface MagpieCheckView {
 schema:'dream-maker.magpie-local-check.v1';
 status:'NOT_RUN'|'PASSED'|'FAILED'|'UNCERTAIN';
 checkedAt:string|null;
 reason:'COMPONENT_NOT_BOUND'|'BUSY'|'CHECK_FAILED'|'CLEANUP_UNCERTAIN'|null;
 processClosed:boolean|null;
 accountVerified:false;modelVerified:false;customExecutionGranted:false;
}
