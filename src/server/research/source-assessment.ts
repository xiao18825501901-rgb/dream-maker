import { Store } from '../store.js';
import { DomainError, hash, id, now, object } from '../security.js';
import { verifySnapshot } from './reuse-policy.mjs';
import type { SourceSnapshot } from '../../shared/research.js';

export interface AssessmentScope {requirementIds:string[];intentHash:string;distribution:string}
/** Reads evidence, not repository instructions. This initial static assessment can refuse reuse;
 * it cannot certify license compatibility, safe installation or actual feature behavior. */
export class SourceAssessments {
    constructor(private store: Store) {}
    inspect(projectId: string, raw: SourceSnapshot, scope: AssessmentScope) {
        this.store.project(projectId);
        const snapshot = verifySnapshot(raw);
        if (!scope || !/^[a-f0-9]{64}$/.test(scope.intentHash) || !Array.isArray(scope.requirementIds) || !scope.requirementIds.length ||
            scope.requirementIds.some(r => !/^[A-Za-z0-9_-]{1,100}$/.test(r)) || !['local-personal','public-source','public-binary'].includes(scope.distribution))
            throw new DomainError('ASSESSMENT_SCOPE_INVALID', 409);
        const scopeHash = hash({projectId,snapshotHash:snapshot.snapshotHash,...scope,policy:'STATIC_SOURCE_FACTS_V1'});
        const old = this.store.records(projectId,'SourceAssessment').map(r => r.data).find(r => r.scopeHash === scopeHash && Date.parse(String(r.expiresAt)) > Date.now());
        if (old) return old;
        const files = snapshot.files.map(f => ({path:f.path,sha256:f.contentSha256,bytes:f.bytes,gitBlobId:f.gitBlobId??null,gitMode:f.gitMode??null}));
        const licenses = snapshot.files.filter(f => /(^|\/)(license|copying|notice)(\.[^/]*)?$/i.test(f.path));
        const manifests = snapshot.files.filter(f => /(^|\/)(package\.json|pyproject\.toml|cargo\.toml|requirements\.txt)$/i.test(f.path)).map(f => {
            if (!f.path.endsWith('package.json')) return {path:f.path,format:'DECLARED_TEXT_NOT_RESOLVED',dependencyCount:null,installHooks:'NOT_VERIFIED'};
            try {
                const manifest = object(JSON.parse(f.content));
                const sections = [manifest.dependencies,manifest.devDependencies,manifest.optionalDependencies,manifest.peerDependencies].map(v => object(v??{}));
                const dependencies = sections.flatMap(v => Object.entries(v));
                const scripts = object(manifest.scripts??{});
                return {path:f.path,format:'JSON_PARSED',dependencyCount:dependencies.length,
                    floatingDependencyCount:dependencies.filter(([,v]) => typeof v !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(v)).length,
                    declaredLicense:typeof manifest.license==='string'&&/^[A-Za-z0-9-.+ ()]{1,100}$/.test(manifest.license)?manifest.license:null,
                    installHooks:['preinstall','install','postinstall','prepare'].filter(k => Object.hasOwn(scripts,k))};
            } catch { return {path:f.path,format:'INVALID_MANIFEST',dependencyCount:null,installHooks:'NOT_VERIFIED'}; }
        });
        const assessment = {id:id('source_assessment'),projectId,scopeHash,snapshotHash:snapshot.snapshotHash,intentHash:scope.intentHash,distribution:scope.distribution,
            at:now(),expiresAt:new Date(Date.now()+24*3600_000).toISOString(),sourceIdentity:'VERIFIED',
            license:{status:'UNKNOWN',evidence:licenses.map(f=>({path:f.path,contentSha256:f.contentSha256})),obligations:[],dependenciesReviewed:false,assetsReviewed:false},
            security:'REVIEW_INCOMPLETE',runtime:'NOT_VERIFIED',installation:'NOT_VERIFIED',ownership:'NOT_VERIFIED',
            coverage:scope.requirementIds.map(requirementId=>({requirementId,status:'BUILD_REQUIRED',explanation:'只有固定源码文本，功能与适用性尚未实际验证。',evidencePaths:[]})),
            mode:'REUSE_COMPONENTS',filesInScope:[],scores:{requirementFit:0,changeCost:0,runtimeFit:0,validationQuality:0,maintenance:0,dependencyComplexity:0},
            inspection:{kind:'CONTROLLER_STATIC_SOURCE_FACTS',files,manifests,licenseFileCount:licenses.length,
                limitations:['许可对本项目用途与分发的适用性尚未核实。','依赖、素材与完整源码范围尚未核实。','安装行为、安全、运行兼容与真实功能尚未验收。'],executedSourceCode:false,modelSelfReviewAccepted:false}};
        this.store.record('SourceAssessment',projectId,null,assessment);
        return assessment;
    }
    verify(raw: unknown): boolean {
        try {
            const value=object(raw);
            if(typeof value.projectId!=='string'||typeof value.id!=='string'||!Number.isFinite(Date.parse(String(value.expiresAt)))||Date.parse(String(value.expiresAt))<=Date.now())return false;
            return this.store.records(value.projectId,'SourceAssessment').some(r=>r.data.id===value.id&&hash(r.data)===hash(value));
        } catch { return false; }
    }
}
