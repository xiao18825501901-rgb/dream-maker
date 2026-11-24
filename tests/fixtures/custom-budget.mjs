// Explicit OFFLINE controller selection for isolated pipe/gateway tests only.
// It is not loaded by production and supplies no account/dispatch qualification.
export function offlineCustomBudget(binding){return{schema:'dream-maker.custom-request-budget.v1',projectId:binding.projectId,runId:binding.runId,configurationHash:binding.configurationHash,roleId:binding.roleId,flow:{currency:'CNY',maxMicros:50000000},role:{currency:'CNY',maxMicros:50000000}};}
// Explicit test callback, never loaded by production or a source of Native receipts.
export function offlineCustomQualification(binding){if(binding.engineeringMode!=='custom')throw Error('OFFLINE_CUSTOM_SCOPE_MISMATCH');}
