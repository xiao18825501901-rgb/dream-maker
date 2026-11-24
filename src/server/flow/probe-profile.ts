import type { Role } from '../../shared/types.js';
import { DomainError } from '../security.js';
export type ProbeProfile='FULL_DM'|'ENGINEERING_ONLY';
/** Controller startup selects this profile; never accept it from HTTP/model/imported data. */
export function probeRoles(profile:ProbeProfile='FULL_DM'):Role[]{
    if(profile==='ENGINEERING_ONLY')return ['planner2','executor','reviewer'];
    if(profile==='FULL_DM')return ['planner1','planner2','executor','reviewer'];
    throw new DomainError('NATIVE_PROBE_PROFILE_INVALID',409);
}
