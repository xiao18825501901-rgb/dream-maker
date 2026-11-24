import { codexPlannerResponsesBody } from './responses-wire.js';
import type { MagpieConcreteRoute } from '../magpie-route.js';

export type PaidCodexResponsesLimits = Parameters<typeof codexPlannerResponsesBody>[1];

export function isPaidCodexResponsesRoute(route?: Readonly<MagpieConcreteRoute>): boolean {
    return route?.runtime === 'codex' && route.authentication === 'api_key' && route.protocol === 'openai-responses';
}

/** The same frozen, tool-free text envelope can serve a paid planner or reviewer. */
export function paidCodexResponsesBody(raw: unknown, limits: PaidCodexResponsesLimits): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.hasOwn(raw, 'store'))
        raw = { ...raw, store: false };
    return codexPlannerResponsesBody(raw, limits);
}
