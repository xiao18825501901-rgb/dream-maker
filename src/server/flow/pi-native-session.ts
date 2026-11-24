import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '../security.js';
import type { RoleToolController } from './dsh-role-tools.js';
import type { PiNativeReply, PiNativeToolTurn, piNativeRequestBody } from './pi-native-wire.js';

type Limits = Parameters<typeof piNativeRequestBody>[1];
export class PiNativeSession {
    readonly limits: Readonly<Limits>;
    private turns: readonly PiNativeToolTurn[] = Object.freeze([]);
    private phase: 'ready' | 'model' | 'tool' | 'dispatch' | 'closed' = 'ready';
    private call: PiNativeReply['toolCall'] = null;

    constructor(limits: Limits) {
        this.limits = Object.freeze({ ...limits, tools: Object.freeze([...limits.tools]) });
    }
    history() { return this.turns; }
    begin() {
        if (this.phase !== 'ready') throw new DomainError('PI_MODEL_TURN_UNAVAILABLE', 409);
        this.phase = 'model';
    }
    settle(call: PiNativeReply['toolCall']) {
        if (this.phase !== 'model') throw new DomainError('PI_MODEL_TURN_UNAVAILABLE', 409);
        if (call && (!this.limits.tools.includes(call.name) || this.turns.some(turn => turn.callId === call.callId)))
            throw new DomainError('PI_UNEXPECTED_TOOL', 409);
        this.call = call && Object.freeze({ ...call });
        this.phase = call ? 'tool' : 'closed';
    }
    close() { this.phase = 'closed'; this.call = null; }
    toolController(controller: RoleToolController): RoleToolController {
        return {dispatch: async (role, name, args, signal) => {
            const call = this.call;
            if (this.phase !== 'tool' || !call || role !== 'executor' || name !== call.name || !isDeepStrictEqual(args, JSON.parse(call.arguments)))
                throw new DomainError('PI_TOOL_INTENT_MISMATCH', 409);
            this.phase = 'dispatch';
            try {
                const result = await controller.dispatch(role, name, args, signal);
                if (signal.aborted || this.call !== call) throw new DomainError('PI_TOOL_RESULT_STALE', 409);
                this.turns = Object.freeze([...this.turns, Object.freeze({ ...call, output: JSON.stringify(result) })]);
                this.call = null;
                this.phase = 'ready';
                return result;
            } catch (error) { this.close(); throw error; }
        }};
    }
}
