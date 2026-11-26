import type { Config, Project } from '../shared/types.js';
import { planner1Binding, SEEKER_PLANNER1_BINDING_VERSION, type Planner1Binding } from './planner1-binding.js';

/**
 * Seeker is the product name of the requirement-clarification role whose internal role id stays
 * planner1 (usage ledgers and frozen specs must not be relabelled). This module answers exactly one
 * question: is this project on the Seeker route?
 *
 * The answer comes from the binding frozen at project creation, never from the current settings, so
 * switching the settings afterwards cannot move an existing project onto another billing path.
 */
export const SEEKER_ROLE = 'planner1' as const;
export const SEEKER_LABEL = 'Seeker';

/**
 * The local planner is the same Seeker route, not a second one. Prompt Optimizer needs a planner
 * that answers, not a particular credential shape: both the official API binding (api_key,
 * version 4) and the local Ollama binding (authMethod none, version 3) drive the same two built-in
 * skills — grillme for the interview, prompt-optimizer for the requirements draft and the plan.
 * Only the Kimi OAuth identity stays out; that one is a frozen historical contract nobody may
 * silently move onto different billing.
 */
type RouteShape = { provider: string; authMethod: string };
const localRoute = (binding: RouteShape): boolean =>
    binding.provider === 'local' && binding.authMethod === 'none';

export function isSeekerApiBinding(binding: Planner1Binding | null | undefined): boolean {
    if (!binding) return false;
    if (localRoute(binding)) return true;
    return binding.bindingVersion === SEEKER_PLANNER1_BINDING_VERSION && binding.authMethod === 'api_key'
        && (binding.provider === 'openai' || binding.provider === 'deepseek');
}

/** The frozen route of an existing project. A project without a frozen binding never runs Seeker skills. */
export function projectSeekerRoute(project: Project): boolean {
    const frozen = project.planner1Binding;
    if (!frozen) return false;
    if (localRoute(frozen)) return true;
    return frozen.bindingVersion === SEEKER_PLANNER1_BINDING_VERSION && frozen.authMethod === 'api_key';
}

/** Route of a *new* project, decided by the settings at creation time. */
export function configuredSeekerRoute(config: Config): boolean {
    return isSeekerApiBinding(planner1Binding(config));
}
