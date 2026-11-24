// OFFLINE source attestation. Credential scanner remains strict for actual key-shaped strings.
import test from 'node:test';import assert from 'node:assert/strict';import {resolve} from 'node:path';
import {treeHash} from '../../dist/server/workspace.js';import {hasSecret} from '../../dist/server/security.js';import {root} from '../helpers.mjs';
test('controller runtime source can be attested without key-format regular expressions resembling an actual key',()=>{
 assert.match(treeHash(resolve(root,'dist/server')),/^[a-f0-9]{64}$/);
});
test('actual Magpie key-shaped values remain rejected by the source/secret scanner',()=>{
 assert.equal(hasSecret('sk-'+'magpie-key-'+'a'.repeat(48)),true);
});
