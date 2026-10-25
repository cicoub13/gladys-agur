import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

// The catalog `countries` filter (Agur is a French water utility)
// needs Gladys 5.3: older releases reject the unknown field.
const MIN_GLADYS_VERSION = '>=5.3.0';
// Store limit of the cover image (800 x 534 PNG or JPEG).
const MAX_COVER_BYTES = 150 * 1024;
// INTEGRATION_CATALOG_CATEGORIES in the core. The manifest schema has no enum
// (an unknown key is dropped with a warning), so a typo here would silently
// land the integration in the uncategorized bucket.
const CATALOG_CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
  'transport',
  'vehicles',
  'servers',
  'leisure',
];

const readJson = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

const manifest = readJson('gladys-assistant-integration.json');
const pkg = readJson('package.json');
const configField = (key) => manifest.config_schema.find((entry) => entry.key === key);

test('the manifest version matches package.json and the image tag', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/cicoub13/gladys-agur:${manifest.version}`);
});

test('the manifest is a cloud device integration on the Gladys release it needs', () => {
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, MIN_GLADYS_VERSION);
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('the name and descriptions fit the store limits', () => {
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const [language, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${language} is ${text.length} chars`,
    );
  }
});

test('the catalog categories are declared and come from the core vocabulary', () => {
  assert.ok(manifest.categories?.length >= 1 && manifest.categories.length <= 3);
  for (const category of manifest.categories) {
    assert.ok(CATALOG_CATEGORIES.includes(category), `unknown catalog category: ${category}`);
  }
});

test('the catalog shows the integration to French instances only', () => {
  assert.deepEqual(manifest.countries, ['FR']);
});

test('no permission is requested that the integration does not use', () => {
  for (const key of ['location', 'network_wake', 'network_discovery', 'containers', 'webhooks']) {
    assert.equal(manifest[key], undefined, `${key} is declared but unused`);
  }
});

test('the password is a secret field, the credentials are required', () => {
  assert.equal(configField('password').type, 'secret');
  assert.equal(configField('password').required, true);
  assert.equal(configField('username').required, true);
});

test('there is no water utility to choose: Agur only', () => {
  assert.equal(configField('provider'), undefined);
});

test('the actions the code registers are the ones the manifest declares', () => {
  assert.deepEqual(
    manifest.actions.map((action) => action.key),
    ['test_connection'],
  );
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /onAction\('test_connection'/);
});

test('every label shown to the user is translated (en + fr)', () => {
  const labeledEntries = [...manifest.config_schema, ...manifest.actions];
  const options = labeledEntries.flatMap((entry) => [
    ...(entry.options ?? []),
    ...(entry.links ?? []),
  ]);
  for (const entry of [...labeledEntries, ...options]) {
    assert.ok(entry.label.en, `missing English label on ${JSON.stringify(entry)}`);
    assert.ok(entry.label.fr, `missing French label on ${JSON.stringify(entry)}`);
  }
});

test('the user docs exist in both languages, long enough for the store', () => {
  for (const language of ['en', 'fr']) {
    const doc = readFileSync(new URL(`../docs/${language}.md`, import.meta.url), 'utf8');
    assert.ok(doc.length >= 300, `docs/${language}.md is too short`);
  }
});

test('the cover image points at a real file within the store limit', () => {
  assert.ok(manifest.cover_image.endsWith('/cover.png'));
  const size = statSync(new URL('../cover.png', import.meta.url)).size;
  assert.ok(size <= MAX_COVER_BYTES, `cover.png is ${size} bytes, over ${MAX_COVER_BYTES}`);
});
