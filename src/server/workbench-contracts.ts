/**
 * One facade for the workbench's backend contracts, so the HTTP layer stays a router.
 *
 * It owns the wiring order the engine decision needs: `EngineModes` asks this facade for the
 * project's stored role configuration, and `RoleConfigurations` asks `EngineModes` to record the
 * new decision after a write. Both directions resolve to the same two objects, so the badge the
 * write returns, the badge a later read returns and the value the Prework gate reads are the same
 * Store rows.
 */
import type { Config } from '../shared/types.js';
import type { RoleCatalogEntryView, RoleConfigSavedView, RoleRegistrySnapshot, StarAnswerView, StarEditSavedView, StarExplainSessionView, StarExplainView } from '../shared/project-roles.js';
import type { EngineView } from './engine-mode.js';
import { EngineModes } from './engine-mode.js';
import { RoleConfigurations, configurationRoleRegistry } from './role-configuration.js';
import { StarAnswers } from './star-answers.js';
import { QuestionExplanations, type ExplanationAskInput, type ExplanationModel } from './question-explanations.js';
import type { Interviews } from './interview.js';
import type { Store } from './store.js';

export interface WorkbenchOptions {
    readonly store: Store;
    /** Instance root: where skills/, prompts/ and .runtime/extensions/ live. */
    readonly root: string;
    readonly config: () => Config;
    readonly interviews: Interviews;
    /** Trusted model surface for explanations; a route without one reports it instead of guessing. */
    readonly explanationModel?: ExplanationModel;
    /**
     * The reviewed registry snapshot. Absent means "the product's own configuration is the
     * registry", which is the truth for the classic lanes; a Magpie lane needs a snapshot that
     * carries the exact executable digest, and without one the write is refused by name.
     */
    readonly registry?: () => RoleRegistrySnapshot | null;
}

export class WorkbenchContracts {
    readonly engines: EngineModes;
    readonly roles: RoleConfigurations;
    readonly stars: StarAnswers;
    readonly explanations: QuestionExplanations;

    constructor(private readonly options: WorkbenchOptions) {
        let roles: RoleConfigurations | undefined;
        this.engines = new EngineModes(options.store, options.config, projectId => roles ? roles.engineSelection(projectId) : null);
        roles = new RoleConfigurations(options.store, options.config, this.engines, options.registry ?? (() => configurationRoleRegistry(options.config())), options.root);
        this.roles = roles;
        this.stars = new StarAnswers(options.store, options.interviews, this.engines);
        this.explanations = new QuestionExplanations(
            options.store,
            options.explanationModel ?? {
                complete: async () => {
                    throw Object.assign(new Error('本机服务没有装配问题解释所用的模型；这一步没有发起任何调用。'), { code: 'EXPLANATION_MODEL_UNAVAILABLE', status: 409 });
                }
            },
            options.config
        );
    }

    engine(projectId: string): EngineView { return this.engines.view(projectId); }

    roleCatalog(projectId: string): { projectId: string; roles: readonly RoleCatalogEntryView[]; engine: EngineView } {
        return { projectId, roles: this.roles.catalog(projectId), engine: this.engines.view(projectId) };
    }

    saveRole(projectId: string, role: unknown, input: { revision: unknown; selection: unknown }, actor: string, operationHash: string): RoleConfigSavedView {
        return this.roles.save(projectId, { role, revision: input.revision, selection: input.selection }, actor, operationHash);
    }

    star(projectId: string, starId: string): StarAnswerView { return this.stars.view(projectId, starId); }

    editStar(projectId: string, starId: string, input: { revision: unknown; answer: unknown }, actor: string): StarEditSavedView {
        return this.stars.edit(projectId, starId, input, actor);
    }

    explain(projectId: string, starId: string, input: ExplanationAskInput): Promise<StarExplainView> {
        return this.explanations.ask(projectId, starId, input);
    }

    explanationsFor(projectId: string, starId: string): readonly StarExplainSessionView[] {
        return this.explanations.history(projectId, starId);
    }

    /** Record the decision of a freshly created project so every later reader finds it stored. */
    recordCreation(projectId: string, actor: string) {
        return this.engines.record(projectId, { source: 'PROJECT_CREATED', actor });
    }
}
