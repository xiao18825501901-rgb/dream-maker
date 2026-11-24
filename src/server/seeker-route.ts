import type { Config, Project } from '../shared/types.js';
import { planner1Binding, SEEKER_PLANNER1_BINDING_VERSION, type Planner1Binding } from './planner1-binding.js';

/**
 * Seeker is the product name of the requirement-clarification role whose internal role id stays
 * planner1 (usage ledgers and frozen specs must not be relabelled). This module answers exactly one
 * question: is this project on the Seeker API route?
 *
 * The answer comes from the binding frozen at project creation, never from the current settings, so
 * switching the settings afterwards cannot move an existing project onto another billing path.
 */
export const SEEKER_ROLE = 'planner1' as const;
export const SEEKER_LABEL = 'Seeker';

export function isSeekerApiBinding(binding: Planner1Binding | null | undefined): boolean {
    return !!binding && binding.bindingVersion === SEEKER_PLANNER1_BINDING_VERSION && binding.authMethod === 'api_key'
        && (binding.provider === 'openai' || binding.provider === 'deepseek');
}

/** The frozen route of an existing project. A project without a frozen binding never runs Seeker skills. */
export function projectSeekerRoute(project: Project): boolean {
    const frozen = project.planner1Binding;
    return !!frozen && frozen.bindingVersion === SEEKER_PLANNER1_BINDING_VERSION && frozen.authMethod === 'api_key';
}

/** Route of a *new* project, decided by the settings at creation time. */
export function configuredSeekerRoute(config: Config): boolean {
    return isSeekerApiBinding(planner1Binding(config));
}
