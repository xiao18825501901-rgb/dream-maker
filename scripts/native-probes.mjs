#!/usr/bin/env node
// Run the four-role minimum probes against the real providers, in order, and report exactly what
// each one returned. Nothing here can promote the budget phase unless all four receipts verify:
// that decision belongs to NativeProbes.advance(), which this script only calls with --advance.
//
// Why a script instead of a test: a probe is a real model call (Kimi subscription / DeepSeek API /
// Codex subscription). Tests must stay offline, so the only honest way to obtain receipts is an
// operator-run command that prints its own refusals.
import { resolve } from 'node:path';
import { Settings } from '../dist/server/config.js';
import { Store } from '../dist/server/store.js';
import { createKimiTransport, KimiRunner } from '../dist/server/providers/kimi.js';
import { loadKimiAdmission } from '../dist/server/kimi-admission.js';
import { createKimiTokenStore } from '../dist/server/kimi-token-store.js';
import { createKimiCredentialAuthority } from '../dist/server/kimi-credential-authority.js';
import { createWindowsCredentialEncryption } from '../dist/server/siwc/windows-credential-encryption.js';
import { createKimiPlanner1Probe } from '../dist/server/kimi-planner1-probe.js';
import { createNativeOwner } from '../dist/server/native-owner.js';
import { ModelProvider } from '../dist/server/providers/model.js';
import { ClashService, withCodexRoleProbeLease } from '../dist/server/clash-service.js';
import { IndependentRunner } from '../dist/server/providers/independent.js';

const root = resolve('.');
const data = resolve(process.env.DM_DATA_DIR || resolve(root, '.runtime'));
const wanted = process.argv.slice(2).filter(a => !a.startsWith('--'));
const roles = wanted.length ? wanted : ['planner1'];
const advance = process.argv.includes('--advance');
const settings = new Settings(resolve(process.env.DM_CONFIG || resolve(root, 'config/local.json')));
const store = new Store(resolve(data, 'dream-maker.sqlite'));
const encryption = createWindowsCredentialEncryption();
const credentials = createKimiCredentialAuthority({ store: createKimiTokenStore({ dir: resolve(data, 'kimi-credentials'), encryption }) });
const k = settings.value.kimi;
const admission = loadKimiAdmission(process.env.DM_KIMI_ENTITLEMENT_FILE ?? resolve(data, 'kimi-entitlement.json'));
const runner = k && k.enabled === true && k.tokenFile
    ? new KimiRunner(() => settings.value, createKimiTransport({ baseUrl: k.baseUrl, tokenFile: k.tokenFile }), undefined, undefined, admission, credentials, () => { })
    : undefined;
const planner1Probe = runner ? createKimiPlanner1Probe({ getConfig: () => settings.value, runner, credentials }) : undefined;
// Built after the owner: a paid planner1 probe needs the owner's reservation guard, and without it the
// Seeker probe could never produce the receipt the Dream Maker profile requires.
let model;
// The independent provider needs the SAME trusted transport the app uses: a direct call from this
// region is refused before authentication, so a probe over plain fetch would only measure the region.
const clash = new ClashService(() => settings.value, resolve(data, 'controller', 'clash-route'));
const independentRunner = new IndependentRunner(() => settings.value, clash.jsonRequest);
// The probe profile follows the surface being proved: the Dream Maker entry needs all four roles
// (FULL_DM), while the DreamFlow engineering entry proves planner2/executor/reviewer only. Without this
// the CLI could never satisfy the engineering gate it exists to open.
const product = process.env.DM_PRODUCT === 'dreamflow' ? 'dreamflow' : 'dream-maker';
const owner = createNativeOwner({ root, store, product, getConfig: () => settings.value, planner1Probe, independentRunner,
    fetch: clash.fetch, fetchForRole: role => clash.fetchForRole(role),
    childEnvironment: extra => clash.childEnvironment(extra) });
// The Dream Maker profile proves a paid planner1 turn, so the model provider has to dispatch through the
// owner's reservation guard (the same one the app passes). DreamFlow's engineering profile has no planner1
// role, so it keeps an unguarded provider and simply never probes that role.
model = new ModelProvider(() => settings.value, root, undefined, product === 'dream-maker' ? owner.paidGuard : undefined);
const report = { schema: 'dream-maker.native-probes.run.v1', at: new Date().toISOString(), results: [], advanced: null };
let failed = 0;
try {
    await credentials.restore();
    for (const role of roles) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 180000);
        try {
            const ref = await withCodexRoleProbeLease(
                clash,
                role,
                controller.signal,
                () => owner.probe(role, controller.signal, model)
            );
            report.results.push({ role, ok: true, ...ref });
            console.log('VERIFIED ' + role + ' evidenceId=' + ref.evidenceId + ' model=' + ref.model + ' source=' + ref.source);
        }
        catch (error) {
            failed += 1;
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
            const message = String(error && typeof error === 'object' && 'message' in error ? error.message : error).slice(0, 240);
            report.results.push({ role, ok: false, code, message });
            console.log('REFUSED ' + role + ' ' + JSON.stringify({ code, message }));
        }
        finally { clearTimeout(timeout); }
    }
    if (advance) {
        if (report.results.some(r => !r.ok)) {
            console.log('ADVANCE_SKIPPED incomplete receipts');
            failed = Math.max(failed, 1);
        }
        else {
            await owner.advanceProbes(model);
            report.advanced = true;
            console.log('ADVANCED phase=REPRESENTATIVE');
        }
    }
}
finally {
    await owner.close?.();
    store.close();
}
console.log(JSON.stringify(report));
process.exitCode = failed ? 1 : 0;
