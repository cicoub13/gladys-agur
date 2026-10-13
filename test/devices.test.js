import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEVICE_TYPE, FEATURE_KEYS, buildDevice, buildStates, idsOf } from '../src/devices.js';

const gladys = createFakeGladys({ selector: 'test' });

const contract = {
  id: '1234567',
  owner: 'M. DUPONT JEAN',
  address: '1 RUE DE LA PAIX 64100 BAYONNE',
  meterSerial: 'I21FA123456',
  readings: [
    { date: new Date('2025-04-30T00:00:00Z'), m3: 81, consumptionM3: 40, dailyAverageM3: 0.2 },
    {
      date: new Date('2025-10-29T00:00:00Z'),
      m3: 127.0004,
      consumptionM3: null,
      dailyAverageM3: null,
    },
    {
      date: new Date('2026-04-30T00:00:00Z'),
      m3: 172,
      consumptionM3: 44.5,
      dailyAverageM3: 0.18548387096774194,
    },
  ],
  invoices: [
    { number: 'F1', amount: 87.654, issuedAt: new Date('2026-03-15T00:00:00Z'), dueAt: null },
  ],
  balance: -12.344,
};

test('the device ids derive from the contract number only (backward compatibility)', () => {
  assert.equal(DEVICE_TYPE, 'water-meter');
  assert.deepEqual(Object.values(FEATURE_KEYS), [
    'index',
    'consumption',
    'daily_average',
    'invoice',
    'amount_due',
  ]);
  const device = buildDevice(gladys, contract, 'Agur');
  assert.equal(device.external_id, 'ext:test:water-meter:1234567');
  assert.deepEqual(
    device.features.map((feature) => feature.external_id),
    [
      'ext:test:water-meter:1234567:index',
      'ext:test:water-meter:1234567:consumption',
      'ext:test:water-meter:1234567:daily_average',
      'ext:test:water-meter:1234567:invoice',
      'ext:test:water-meter:1234567:amount_due',
    ],
  );
});

test('the device is named after the meter and carries the contract as params', () => {
  const device = buildDevice(gladys, contract, 'Agur');
  assert.equal(device.name, 'Agur I21FA123456');
  assert.deepEqual(device.params, [
    { name: 'CONTRACT_NUMBER', value: '1234567' },
    { name: 'METER_SERIAL_NUMBER', value: 'I21FA123456' },
    { name: 'ADDRESS', value: '1 RUE DE LA PAIX 64100 BAYONNE' },
  ]);
  const bare = buildDevice(gladys, { ...contract, meterSerial: null, address: null }, 'Agur');
  assert.equal(bare.name, 'Agur 1234567');
  assert.deepEqual(bare.params, [{ name: 'CONTRACT_NUMBER', value: '1234567' }]);
});

test('every feature is a read-only sensor with history, in a standard category and unit', () => {
  const byKey = Object.fromEntries(
    buildDevice(gladys, contract, 'Agur').features.map((feature) => [
      feature.external_id.split(':').pop(),
      feature,
    ]),
  );
  assert.deepEqual(
    [byKey.index.category, byKey.index.type, byKey.index.unit],
    ['volume-sensor', 'decimal', 'cubicmeter'],
  );
  assert.deepEqual(
    [byKey.consumption.category, byKey.consumption.type, byKey.consumption.unit],
    ['volume-sensor', 'decimal', 'cubicmeter'],
  );
  assert.deepEqual(
    [byKey.daily_average.category, byKey.daily_average.type, byKey.daily_average.unit],
    ['volume-sensor', 'integer', 'liter'],
  );
  for (const key of ['invoice', 'amount_due']) {
    assert.deepEqual(
      [byKey[key].category, byKey[key].type, byKey[key].unit],
      ['currency', 'decimal', 'euro'],
    );
  }
  for (const feature of Object.values(byKey)) {
    assert.equal(feature.read_only, true);
    assert.equal(feature.has_feedback, false);
    assert.equal(feature.keep_history, true);
    assert.ok(feature.min < feature.max);
  }
});

test('readings and invoices are dated, then the current values are repeated undated', () => {
  const ids = idsOf(gladys, contract.id);
  const states = buildStates(gladys, contract);
  const of = (key) =>
    states.filter((state) => state.device_feature_external_id === ids.feature(key));

  assert.deepEqual(of('index'), [
    {
      device_feature_external_id: ids.feature('index'),
      state: 81,
      created_at: '2025-04-30T00:00:00.000Z',
    },
    {
      device_feature_external_id: ids.feature('index'),
      state: 127,
      created_at: '2025-10-29T00:00:00.000Z',
    },
    {
      device_feature_external_id: ids.feature('index'),
      state: 172,
      created_at: '2026-04-30T00:00:00.000Z',
    },
    // The latest one again, "now": Gladys hides values older than 48 h.
    { device_feature_external_id: ids.feature('index'), state: 172 },
  ]);
  // Agur's figure when it gives one, else the index difference.
  assert.deepEqual(
    of('consumption').map(({ state, created_at: createdAt }) => [state, createdAt]),
    [
      [40, '2025-04-30T00:00:00.000Z'],
      [46, '2025-10-29T00:00:00.000Z'],
      [44.5, '2026-04-30T00:00:00.000Z'],
    ],
  );
  assert.deepEqual(of('invoice'), [
    {
      device_feature_external_id: ids.feature('invoice'),
      state: 87.65,
      created_at: '2026-03-15T00:00:00.000Z',
    },
    { device_feature_external_id: ids.feature('invoice'), state: 87.65 },
  ]);
  // Periods, never repeated undated (they would read as new periods).
  for (const key of ['consumption', 'daily_average']) {
    assert.ok(of(key).every((state) => state.created_at !== undefined));
  }
  // Liters per day, rounded; none when Agur gives no average.
  assert.deepEqual(
    of('daily_average').map(({ state, created_at: createdAt }) => [state, createdAt]),
    [
      [200, '2025-04-30T00:00:00.000Z'],
      [185, '2026-04-30T00:00:00.000Z'],
    ],
  );
  // Agur shows what is due as a negative balance: flipped.
  assert.deepEqual(of('amount_due'), [
    { device_feature_external_id: ids.feature('amount_due'), state: 12.34 },
  ]);
  const settled = buildStates(gladys, { ...contract, readings: [], invoices: [], balance: 0 });
  assert.ok(Object.is(settled[0].state, 0), 'a zero balance is 0, not -0');
  assert.equal(
    buildStates(gladys, { ...contract, readings: [], balance: 30.5 }).at(-1).state,
    -30.5,
  );
});

test('no consumption across a meter replacement, no amount due when unknown', () => {
  const states = buildStates(gladys, {
    ...contract,
    readings: [
      {
        date: new Date('2025-04-30T00:00:00Z'),
        m3: 1500,
        consumptionM3: null,
        dailyAverageM3: null,
      },
      { date: new Date('2025-10-29T00:00:00Z'), m3: 12, consumptionM3: null, dailyAverageM3: null },
      {
        date: new Date('2026-04-30T00:00:00Z'),
        m3: 52.25,
        consumptionM3: null,
        dailyAverageM3: null,
      },
    ],
    invoices: [],
    balance: null,
  });
  const keys = states.map((state) => state.device_feature_external_id.split(':').pop());
  assert.deepEqual(keys, ['index', 'index', 'index', 'consumption', 'index']);
  assert.equal(states[3].state, 40.25);
});
