import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('Magpie overlay manifest, original bases and applied build source are byte-identical',()=>{
  const result=spawnSync(process.execPath,[resolve('scripts/revamp/verify-magpie-overlay.mjs')],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.status,'PASS');
  assert.equal(report.upstreamCommit,'1aca55909ff94f5c23091ce35f73cb4b7bc46658');
  assert.equal(report.toolchain,'go1.26.8');
  assert.equal(report.files.length,16);
  assert.ok(report.files.every(file=>file.buildSourceMatch));
  assert.equal(report.files.find(file=>file.path==='internal/gateway/dm_transport.go').sha256,'ece4feb3ab5e718880b9fd9613f5962d1f8b83d029fb51746f2021641beff222');
});
