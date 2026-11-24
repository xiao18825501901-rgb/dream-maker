export interface RoleEventOwnership {
    dispatchId: string;
    generation: string;
}

export interface RoleEventRecord {
    type: 'agent.event' | 'network.codex-request';
    payload: unknown;
}

/** Keep request diagnostics out of the strict agent recovery event stream. */
export function roleEventRecord(value: Record<string, unknown>, reviewSupplement: boolean, ownership?: RoleEventOwnership): RoleEventRecord {
    if (value.method === 'dm/codexRequestPath') {
        return {type: 'network.codex-request', payload: value.params ?? null};
    }
    return {
        type: 'agent.event',
        payload: reviewSupplement && ownership ? {...value, dispatchId: ownership.dispatchId, generation: ownership.generation} : value
    };
}
