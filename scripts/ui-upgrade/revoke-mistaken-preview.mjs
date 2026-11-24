// One-shot correction exception. This module has no create/deploy operation.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { childEnv } from '../../dist/server/security.js';

const siteId = '1694ed84-c090-473e-91c5-90d0c0103270';
const name = 'dream-maker-ui-demo-20261012-1b47cd';
const accountId = '6a73fc4e89d35ebed49655dd';
if (process.argv[2] !== '--revoke-exact-site') throw Error('EXACT_REVOCATION_FLAG_REQUIRED');
const dir = resolve('docs/ui-upgrade/evidence/runs', `revocation-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const cli = resolve(process.env.APPDATA, 'npm/node_modules/netlify-cli/bin/run.js');
const env = childEnv({ CI: 'true', APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME });
const actions = new Set(['getSite', 'listSiteDeploys', 'deleteSite']);
function call(action) {
  if (!actions.has(action)) throw Error('ACTION_DENIED');
  return spawnSync(process.execPath, [cli, 'api', action, '--data', JSON.stringify({ site_id: siteId })],
    { cwd: resolve('ui-release'), env, encoding: 'utf8', timeout: 30000, maxBuffer: 1000000 });
}
const first = call('getSite');
if (first.status !== 0) throw Error('IDENTITY_READ_FAILED; no mutation performed');
const site = JSON.parse(first.stdout);
if (site.id !== siteId || site.name !== name || site.account_id !== accountId)
  throw Error('SITE_IDENTITY_MISMATCH; no mutation performed');
const list = call('listSiteDeploys');
if (list.status !== 0) throw Error('DEPLOY_IDENTITY_READ_FAILED; no mutation performed');
const deploys = JSON.parse(list.stdout);
if (deploys.some(d => d.site_id !== siteId)) throw Error('DEPLOY_SITE_MISMATCH');
const report = { schema: 'dream-maker.exact-preview-revocation.v1', at: new Date().toISOString(),
  siteId, name, accountId, publishedDeployId: site.published_deploy?.id ?? null,
  gitRepository: site.build_settings?.repo_url ?? null,
  automaticBuildsStopped: site.build_settings?.stop_builds ?? null,
  deploys: deploys.map(d => ({ id: d.id, siteId: d.site_id, state: d.state, context: d.context })),
  authorizedMutation: 'deleteSite exact independent site only', result: 'PENDING' };
const save = () => writeFileSync(resolve(dir, 'revocation.json'), JSON.stringify(report, null, 2) + '\n');
save();
const deletion = call('deleteSite');
report.deleteExitCode = deletion.status;
// A timeout is an unknown mutation result; read back before considering any retry.
const after = call('getSite');
report.absenceExitCode = after.status;
report.absenceHttp404Observed = after.status !== 0 && /\b404\b|Not Found/i.test(after.stderr + after.stdout);
report.result = report.absenceHttp404Observed ? 'REVOKED_SITE_ABSENT' : 'REMOTE_PREVIEW_REVOCATION_BLOCKED';
report.otherSiteMutations = 0;
save();
console.log(JSON.stringify({ ...report, evidence: resolve(dir, 'revocation.json') }));
if (!report.absenceHttp404Observed) process.exitCode = 1;
