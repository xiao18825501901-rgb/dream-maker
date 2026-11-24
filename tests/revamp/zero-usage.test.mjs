// 零用量部署开关：付费路径必须 fail closed，本地回环不受影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPaidDispatchAllowed, zeroUsageEnabled, ZERO_USAGE_ENV } from '../../dist/server/zero-usage.js';

test('zero-usage switch is off unless the environment says exactly 1 or true', () => {
  const saved = process.env[ZERO_USAGE_ENV];
  try {
    delete process.env[ZERO_USAGE_ENV];
    assert.equal(zeroUsageEnabled(), false);
    for (const value of ['0', '', 'yes', 'TRUE ', '2']) {
      process.env[ZERO_USAGE_ENV] = value;
      assert.equal(zeroUsageEnabled(), false, 'value ' + JSON.stringify(value) + ' must not enable it');
    }
    for (const value of ['1', 'true']) {
      process.env[ZERO_USAGE_ENV] = value;
      assert.equal(zeroUsageEnabled(), true);
    }
  } finally { if (saved === undefined) delete process.env[ZERO_USAGE_ENV]; else process.env[ZERO_USAGE_ENV] = saved; }
});

test('a paid dispatch is refused by name under zero-usage, and the loopback path is untouched', () => {
  const saved = process.env[ZERO_USAGE_ENV];
  try {
    process.env[ZERO_USAGE_ENV] = '1';
    assert.throws(() => assertPaidDispatchAllowed(false), (error) => {
      assert.equal(error.code, 'ZERO_USAGE_DEPLOYMENT');
      assert.match(String(error.message), /DM_ZERO_USAGE/);
      return true;
    });
    assert.doesNotThrow(() => assertPaidDispatchAllowed(true));
  } finally { if (saved === undefined) delete process.env[ZERO_USAGE_ENV]; else process.env[ZERO_USAGE_ENV] = saved; }
});

test('the switch is inert when it is not set at all', () => {
  const saved = process.env[ZERO_USAGE_ENV];
  try {
    delete process.env[ZERO_USAGE_ENV];
    assert.doesNotThrow(() => assertPaidDispatchAllowed(false));
    assert.doesNotThrow(() => assertPaidDispatchAllowed(true));
  } finally { if (saved === undefined) delete process.env[ZERO_USAGE_ENV]; else process.env[ZERO_USAGE_ENV] = saved; }
});
