/**
 * Unit tests for config normalization.
 *
 * These run without a DSH runtime: `lib/config.js` imports
 * `@deepseek-ai/schemastery` dynamically and tolerates its absence, which is
 * exactly the situation for a locally linked install — and for this test.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG_DEFAULTS, HAS_SCHEMA, resolveConfig } from '../lib/config.js';

test('defaults are complete and frozen', () => {
  assert.equal(Object.isFrozen(CONFIG_DEFAULTS), true);
  for (const key of ['autoCheck', 'autoRepair', 'deepReload', 'watchProfile', 'devReload', 'verbose']) {
    assert.equal(typeof CONFIG_DEFAULTS[key], 'boolean', `${key} must default to a boolean`);
  }
  for (const key of ['debounceMs', 'startupDelayMs', 'pollIntervalMs']) {
    assert.equal(typeof CONFIG_DEFAULTS[key], 'number', `${key} must default to a number`);
  }
  assert.deepEqual(CONFIG_DEFAULTS.devWatch, []);
});

test('an absent config yields the defaults', () => {
  assert.deepEqual(resolveConfig(undefined), { ...CONFIG_DEFAULTS });
  assert.deepEqual(resolveConfig(null), { ...CONFIG_DEFAULTS });
  assert.deepEqual(resolveConfig('nonsense'), { ...CONFIG_DEFAULTS });
});

test('a partial config keeps the other defaults', () => {
  const resolved = resolveConfig({ autoRepair: false, debounceMs: 50 });
  assert.equal(resolved.autoRepair, false);
  assert.equal(resolved.debounceMs, 50);
  assert.equal(resolved.deepReload, CONFIG_DEFAULTS.deepReload);
});

test('devWatch is always a clean array of absolute-looking strings', () => {
  assert.deepEqual(resolveConfig({ devWatch: 'C:/one/path' }).devWatch, []);
  assert.deepEqual(resolveConfig({ devWatch: ['C:/a', '', 42, 'C:/b'] }).devWatch, ['C:/a', 'C:/b']);
  assert.deepEqual(resolveConfig({ devWatch: [] }).devWatch, []);
});

test('numeric fields fall back when they are not usable numbers', () => {
  const resolved = resolveConfig({ debounceMs: -1, startupDelayMs: 'soon', pollIntervalMs: Number.NaN });
  assert.equal(resolved.debounceMs, CONFIG_DEFAULTS.debounceMs);
  assert.equal(resolved.startupDelayMs, CONFIG_DEFAULTS.startupDelayMs);
  assert.equal(resolved.pollIntervalMs, CONFIG_DEFAULTS.pollIntervalMs);
  // 0 is meaningful: it disables the fingerprint poll.
  assert.equal(resolveConfig({ pollIntervalMs: 0 }).pollIntervalMs, 0);
});

test('route is a string or the default', () => {
  assert.equal(resolveConfig({ route: '' }).route, '', 'empty string is the documented "disable" value');
  assert.equal(resolveConfig({ route: '/custom' }).route, '/custom');
  assert.equal(resolveConfig({ route: 42 }).route, CONFIG_DEFAULTS.route);
});

test('the optional schema is reported, not required', () => {
  assert.equal(typeof HAS_SCHEMA, 'boolean');
});
