import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgurIntegration, POLL_INTERVAL_MS, RETRY_INTERVAL_MS } from '../src/integration.js';
import { AgurError } from '../src/agur/client.js';
import { StatePublisher } from '../src/publisher.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const DEVICE_ID = 'ext:test:water-meter:1234567';
const CONFIG = { provider: 'agur', username: 'me@example.com', password: 'pw' };

const contract = (overrides = {}) => ({
  id: '1234567',
  owner: null,
  address: null,
  meterSerial: 'I21FA123456',
  readings: [
    { date: new Date('2025-10-29T00:00:00Z'), m3: 100, consumptionM3: null, dailyAverageM3: null },
    { date: new Date('2026-04-30T00:00:00Z'), m3: 110, consumptionM3: null, dailyAverageM3: null },
  ],
  invoices: [],
  balance: 5,
  ...overrides,
});

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// Manual timers: polls only run when a test says so.
function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimer(fn, delay) {
      const id = nextId++;
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    get nextDelay() {
      return [...pending.values()][0]?.delay;
    },
  };
}

function setup({ devices = [{ external_id: DEVICE_ID }], snapshots } = {}) {
  const gladys = createFakeGladys({ devices });
  const timers = fakeTimers();
  const queue = [...(snapshots ?? [{ contracts: [contract()], warnings: [] }])];
  const fetches = [];
  const client = {
    logins: 0,
    async login() {
      this.logins += 1;
    },
    async getContracts() {
      return { resultats: [{ numeroContrat: '1234567' }] };
    },
  };
  const integration = new AgurIntegration(gladys, {
    createClient: (config) => {
      client.config = config;
      return client;
    },
    fetchSnapshot: async () => {
      fetches.push(true);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    publisher: new StatePublisher({ gladys, sleep: async () => {} }),
    logger: silentLogger,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { gladys, integration, timers, client, fetches };
}

test('without credentials: reports what is missing and does not poll', async () => {
  const { gladys, integration, timers, fetches } = setup();
  await integration.applyConfig({ username: 'me@example.com' });
  assert.equal(gladys.calls.connectionStatuses.length, 1);
  assert.equal(gladys.calls.connectionStatuses[0].connected, false);
  assert.match(gladys.calls.connectionStatuses[0].message.fr, /mot de passe/);
  assert.equal(fetches.length, 0);
  assert.equal(timers.pending.size, 0);
  await assert.rejects(integration.testConnection(), /Enter the email/);
  await assert.rejects(integration.handleScan(), /Enter the email/);
});

test('a poll reports the connection, publishes the devices and the states of created ones', async () => {
  const { gladys, integration, timers, client } = setup();
  await integration.applyConfig(CONFIG);

  assert.equal(client.config.username, 'me@example.com');
  assert.deepEqual(gladys.calls.connectionStatuses, [{ connected: true, message: undefined }]);
  assert.equal(gladys.calls.discovered.length, 1);
  assert.equal(gladys.calls.discovered[0][0].external_id, DEVICE_ID);
  assert.equal(gladys.calls.discovered[0][0].name, 'Agur I21FA123456');
  assert.deepEqual(
    gladys.calls.states.map((state) => state.device_feature_external_id.split(':').pop()),
    ['index', 'index', 'consumption', 'amount_due'],
  );
  assert.equal(timers.nextDelay, POLL_INTERVAL_MS);
});

test('states of devices the user did not create are not sent', async () => {
  const { gladys, integration } = setup({ devices: [] });
  await integration.applyConfig(CONFIG);
  assert.equal(gladys.calls.discovered.length, 1);
  assert.equal(gladys.calls.states.length, 0);
});

test('the next poll only sends what is new, and the devices again', async () => {
  const later = contract({
    readings: [
      ...contract().readings,
      { date: new Date('2026-10-10T00:00:00Z'), m3: 125, consumptionM3: 15, dailyAverageM3: null },
    ],
  });
  const { gladys, integration } = setup({
    snapshots: [
      { contracts: [contract()], warnings: [] },
      { contracts: [later], warnings: ['contract 1234567 invoices: HTTP 500'] },
    ],
  });
  await integration.applyConfig(CONFIG);
  gladys.calls.states.length = 0;

  await integration.poll();
  assert.deepEqual(
    gladys.calls.states.map(({ state }) => state),
    [125, 15],
  );
  assert.equal(gladys.calls.discovered.length, 2);
  // Still connected: no new status.
  assert.equal(gladys.calls.connectionStatuses.length, 1);
});

test('a failed poll reports the reason and retries sooner', async () => {
  const { gladys, integration, timers } = setup({
    snapshots: [new AgurError('timeout', 'slow')],
  });
  await integration.applyConfig(CONFIG);
  const [status] = gladys.calls.connectionStatuses;
  assert.equal(status.connected, false);
  assert.match(status.message.fr, /n'a pas répondu à temps/);
  assert.equal(timers.nextDelay, RETRY_INTERVAL_MS);

  // Same outage: reported once.
  await integration.poll();
  assert.equal(gladys.calls.connectionStatuses.length, 1);
});

test('a refused login suspends the updates until the connection is tested again', async () => {
  const { gladys, integration, timers, client, fetches } = setup({
    snapshots: [
      new AgurError('auth', 'refused', { serverMessage: 'Mot de passe incorrect' }),
      { contracts: [contract()], warnings: [] },
    ],
  });
  await integration.applyConfig(CONFIG);
  const [status] = gladys.calls.connectionStatuses;
  assert.match(status.message.fr, /Mot de passe incorrect.*suspendues/);
  assert.equal(timers.pending.size, 0);
  assert.equal(integration.poller.stopped, true);

  const result = await integration.testConnection();
  assert.equal(client.logins, 1);
  assert.match(result.fr, /Connecté à Agur : 1 contrat\(s\) trouvé\(s\)\./);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches.length, 2);
  assert.equal(gladys.calls.connectionStatuses.at(-1).connected, true);
});

test('the connection test turns an Agur error into a readable bilingual one', async () => {
  const { integration, client } = setup();
  await integration.applyConfig(CONFIG);
  client.login = async () => {
    throw new AgurError('unreachable', 'down');
  };
  await assert.rejects(
    integration.testConnection(),
    /Agur cannot be reached.* \/ Agur est injoignable/,
  );
});

test('Gladys-side failures during a poll are not reported as an Agur outage', async () => {
  const { gladys, integration } = setup();
  gladys.failNext('publishDiscoveredDevices');
  await integration.applyConfig(CONFIG);
  assert.deepEqual(
    gladys.calls.connectionStatuses.map(({ connected }) => connected),
    [true],
  );
  assert.equal(integration.lastError, null);
});

test('a device created after the first poll gets its full history right away', async () => {
  const { gladys, integration } = setup({ devices: [] });
  await integration.applyConfig(CONFIG);
  assert.equal(gladys.calls.states.length, 0);

  gladys.devices = [{ external_id: DEVICE_ID }];
  await integration.handleDeviceCreated({ external_id: DEVICE_ID });
  assert.equal(gladys.calls.states.length, 4);

  // Deleted then created again: everything is sent again.
  integration.handleDeviceDeleted({ external_id: DEVICE_ID });
  await integration.handleDeviceCreated({ external_id: DEVICE_ID });
  assert.equal(gladys.calls.states.length, 8);

  // A foreign device does not reset ours.
  integration.handleDeviceDeleted({ external_id: 'ext:other:thing:1' });
  await integration.handleDeviceCreated({ external_id: 'ext:other:thing:1' });
  assert.equal(gladys.calls.states.length, 8);
});

test('a failure while sending a new device history is logged, not thrown', async () => {
  const { gladys, integration } = setup();
  await integration.applyConfig(CONFIG);
  gladys.failNext('getDevices');
  await integration.handleDeviceCreated({ external_id: DEVICE_ID });
});

test('the same account after a reconnection is not sent again; another account is', async () => {
  const { gladys, integration } = setup();
  await integration.applyConfig(CONFIG);
  assert.equal(gladys.calls.states.length, 4);

  await integration.applyConfig(CONFIG);
  assert.equal(gladys.calls.states.length, 4);

  await integration.applyConfig({ ...CONFIG, username: 'other@example.com' });
  assert.equal(gladys.calls.states.length, 8);
});

test('a poll resolving after a config change publishes nothing', async () => {
  const { gladys, integration } = setup();
  let release;
  integration.fetchSnapshot = () =>
    new Promise((resolve) => {
      release = () => resolve({ contracts: [contract()], warnings: [] });
    });
  integration.config = { ...CONFIG };
  integration.client = {};
  const poll = integration.poll();
  integration.generation += 1;
  release();
  await poll;
  assert.equal(gladys.calls.discovered.length, 0);
  assert.equal(integration.snapshot, null);
});

test('a scan publishes the last devices, or starts a read when there is none', async () => {
  const { gladys, integration, fetches } = setup();
  await integration.applyConfig(CONFIG);
  await integration.handleScan();
  assert.equal(gladys.calls.discovered.length, 2);

  integration.snapshot = null;
  integration.lastError = { en: 'Agur cannot be reached.', fr: 'Agur est injoignable.' };
  await assert.rejects(integration.handleScan(), /Agur cannot be reached/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches.length, 2);
});

test('stop() leaves no timer behind', async () => {
  const { integration, timers } = setup();
  await integration.applyConfig(CONFIG);
  integration.stop();
  assert.equal(timers.pending.size, 0);
});
