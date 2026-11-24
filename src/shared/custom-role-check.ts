import type {InspectCustomAccountSources} from './custom-account-sources.js';
/** Current controller readback of a minimum role call; never project execution authority. */
export interface CustomRoleCheckView {
    schema:'dream-maker.custom-role-check.v1';projectId:string;
    role:'planner2'|'executor'|'reviewer';roleId:string;
    selection:InspectCustomAccountSources;configurationHash:string;
    status:'NOT_RUN'|'RUNNING'|'PASSED_MINIMUM'|'FAILED'|'FAILED_NO_EFFECT'|'UNCERTAIN'|'NOT_CURRENT'|'NOT_ADMITTED';
    checkedAt:string|null;evidenceId:string|null;model:string|null;
    executionGranted:false;fourRoleLive:'NOT_RUN';
}
