/** Stable controller codes only: never inspect or copy provider exception text. */
const uncertain=new Set(['PROCESS_CLEANUP_UNPROVEN','PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED','DISPATCH_PROCESS_OWNERSHIP_PROOF_REQUIRED','CLASH_RESTORE_REQUIRES_LOCAL_RECOVERY','CLASH_RESTORE_READBACK_MISMATCH','NATIVE_PROBE_CLEANUP_UNCERTAIN','NATIVE_OWNER_CLEANUP_UNCERTAIN','SANDBOX_RESOURCE_CLEANUP_UNPROVEN']);
export function cleanupUncertain(error:unknown):boolean{
    return !!error&&typeof error==='object'&&typeof (error as {code?:unknown}).code==='string'&&uncertain.has((error as {code:string}).code);
}
