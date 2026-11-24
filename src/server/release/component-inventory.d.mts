export const REQUIRED_CORE_COMPONENTS:string[];
export interface ReleaseComponent {id:string;bundled?:boolean;redistributionReviewed?:boolean;licenseEvidenceRef?:string;syntheticOnly?:boolean;cleanMachineRunVerified?:boolean;artifactHash?:string;measuredBytes?:number}
export function qualifyDistribution(input:{components:ReleaseComponent[];platform?:string;variant:'INSTALLER'|'PORTABLE';liveAccountsReady?:boolean}):{
 scope:'RELEASE_CHECKLIST_NOT_INSTALLER';completeCore:false;evidenceVerified:false;problems:{component:string;code:string}[];accountReady:false;callerLiveAccountClaimIgnored:boolean;modelsBundled:false;optionalComponents:string[];measuredBytes:number;
};
export interface PinnedEvidenceReference {path:string;sha256:string}
export interface ComponentEvidence {
 id:string;version:string;source:{kind:'GIT_COMMIT'|'RELEASE_ASSET'|'LOCAL_PACKAGE';locator:string;revision:string};
 artifact:PinnedEvidenceReference&{bytes:number};license:PinnedEvidenceReference;sbom:PinnedEvidenceReference;cleanWindows:PinnedEvidenceReference;
}
export interface ComponentEvidenceFragmentResult {
 scope:'COMPONENT_EVIDENCE_FRAGMENT';componentId:string;evidenceVerified:boolean;completeDistribution:false;releaseReady:false;
 problems:{component:string;code:string}[];component:{id:string;version:string;artifactSha256:string;artifactBytes:number;source:ComponentEvidence['source']}|null;measuredBytes:number;
}
export function qualifyComponentEvidenceFragment(input:{root:string;component:ComponentEvidence}):ComponentEvidenceFragmentResult;
export function qualifyDistributionEvidence(input:{root:string;manifestPath:string;expectedManifestSha256?:string;platform?:string;variant:'INSTALLER'|'PORTABLE'}):{
 scope:'VERIFIED_COMPONENT_EVIDENCE_RELEASE_GATE';completeCore:boolean;evidenceVerified:boolean;problems:{component:string;code:string}[];
 components:{id:string;version:string;artifactSha256:string;artifactBytes:number;source:ComponentEvidence['source']}[];accountReady:false;modelsBundled:false;
 optionalComponents:string[];measuredBytes:number;manifestSha256:string|null;manifestPath?:string;
};
