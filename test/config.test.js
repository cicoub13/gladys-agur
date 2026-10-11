import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, PROVIDERS, isConfigured, normalizeConfig } from '../src/config.js';

test('defaults when nothing is configured, including an explicit null', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
});

test('trims the username but not the password', () => {
  const config = normalizeConfig({
    provider: 'agur',
    username: ' me@example.com ',
    password: ' s3cret ',
  });
  assert.deepEqual(config, {
    provider: 'agur',
    username: 'me@example.com',
    password: ' s3cret ',
  });
});

test('an unknown or inherited provider falls back to Agur', () => {
  // Grand Paris Sud and Eau de Paris are not supported (see config.js).
  assert.equal(normalizeConfig({ provider: 'grandparissud' }).provider, 'agur');
  assert.equal(normalizeConfig({ provider: 'eauparis' }).provider, 'agur');
  assert.equal(normalizeConfig({ provider: 'veolia' }).provider, 'agur');
  assert.equal(normalizeConfig({ provider: 'toString' }).provider, 'agur');
  assert.equal(normalizeConfig({ provider: 42 }).provider, 'agur');
});

test('non-string credentials are ignored', () => {
  const config = normalizeConfig({ username: 42, password: {} });
  assert.equal(config.username, '');
  assert.equal(config.password, '');
});

test('both the username and the password are needed', () => {
  assert.equal(isConfigured(normalizeConfig({ username: 'me', password: 'pw' })), true);
  assert.equal(isConfigured(normalizeConfig({ username: 'me' })), false);
  assert.equal(isConfigured(normalizeConfig({ password: 'pw' })), false);
});

test('Agur is the only portal, with its host and keys', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['agur']);
  const { name, host, clientId, accessKey } = PROVIDERS.agur;
  assert.ok(name && host && clientId && accessKey);
});
