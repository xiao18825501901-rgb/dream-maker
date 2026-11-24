// OFFLINE bridge fixture. It is not the DSH runtime and never contacts DeepSeek.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
export async function capabilities() { return { fixture: true, verified: false }; }
export async function run(input, emit, signal) { if (input.model !== 'deepseek-flash')
    throw Error('MODEL_ROUTE_MISMATCH'); if (process.env[process.env.DM_DSH_KEY_ENV] === 'synthetic-bridge-test-value')
    throw Error('REAL_PROVIDER_CREDENTIAL_REACHED_ADAPTER'); if (!process.env[process.env.DM_DSH_KEY_ENV])
    throw Error('FIXTURE_KEY_NOT_PASSED'); writeFileSync(resolve(input.workspace, 'fixture-executor.txt'), 'OFFLINE FIXTURE'); emit({ type: 'fixture-tool-result', isError: false }); return { text: 'OFFLINE DSH ADAPTER FIXTURE', sessionId: 'fixture-dsh-session' }; }
export async function verify() { if (process.env[process.env.DM_DSH_KEY_ENV])
    throw Error('PROVIDER_KEY_LEAKED_INTO_VERIFIER'); if (process.env.DM_MODEL_GATEWAY_URL || process.env.DM_MODEL_GATEWAY_TOKEN)
    throw Error('GATEWAY_CAPABILITY_LEAKED_INTO_VERIFIER'); return { command: ['offline-fixture-verifier'], exitCode: 0, stdout: 'NO_PROVIDER_KEY', stderr: '' }; }
export async function close() { }
