import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('Local-Only: old public commands reject before loading network or CLI code', () => {
  for (const name of ['publish-ui.mjs','probe-deployment-readonly.mjs','recover-deploy-readonly.mjs']) {
    const path = 'scripts/ui-upgrade/' + name;
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /\b(?:import|fetch|spawn|require)\b/);
    for (const mode of ['preview', 'production', '--force']) {
      const result = spawnSync(process.execPath, [path, mode], { encoding: 'utf8', timeout: 5000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /LOCAL_ONLY_PUBLIC_ACCESS_REVOKED/);
    }
  }
  for (const name of ['browser-public.py', 'inspect-public-sample.py']) {
    const source = readFileSync('scripts/ui-upgrade/' + name, 'utf8');
    assert.match(source, /raise SystemExit\("LOCAL_ONLY_PUBLIC_ACCESS_REVOKED"\)/);
    assert.doesNotMatch(source.replace(/^#.*$/gm,''), /\b(?:import|requests|urllib)\b/);
  }
});

test('Local-Only build has no publication, platform config or automatic downloads', async t => {
  const source = readFileSync('scripts/ui-upgrade/build-ui.mjs', 'utf8');
  assert.doesNotMatch(source, /ui-release\/public|netlify|\bdeploy\b|\bnpx\b|npm install|https?:\/\//i);
  assert.match(source, /OFFLINE_TYPESCRIPT_REQUIRED/);
  // The chat shell keeps app.js as its compatibility entry (?ui=legacy imports it), so the local
  // build manifest still names app.js as the entry it records and still refuses to publish anything.
  assert.match(source, /entry:'app.js'/);
  assert.match(source, /publicReleaseCreated:false/);
  await t.test('the local build ships no platform configuration', t => {
    const configPath = 'ui-release/netlify.toml';
    if (!existsSync(configPath)) {
      // ui-release/ is a published artifact: source and integration checkouts carry src+dist only.
      // Skipped with a stated reason instead of failing ENOENT, and never counted as a pass.
      const reason = 'ui-release/netlify.toml is absent from this checkout, so there is no platform config to inspect here';
      console.error('local-only SKIP: ' + reason);
      return t.skip(reason);
    }
    assert.equal(readFileSync(configPath, 'utf8').replace(/^#.*$/gm,'').trim(), '');
  });
});
