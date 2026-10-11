import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contractEntries,
  fetchSnapshot,
  parseContract,
  parseDate,
  parseInvoices,
  parseNumber,
  parseReadings,
} from '../src/agur/snapshot.js';
import { AgurClient, AgurError } from '../src/agur/client.js';
import { PROVIDERS } from '../src/config.js';
import {
  CONTRACTS,
  CONTRACT_DETAIL,
  INVOICES,
  READINGS,
  createFakeFetch,
} from './fixtures/agur.js';

test('parseNumber reads JSON numbers and French-formatted strings', () => {
  assert.equal(parseNumber(12.5), 12.5);
  assert.equal(parseNumber('12.5'), 12.5);
  assert.equal(parseNumber('-12,34'), -12.34);
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('1 234,56 €'), 1234.56);
  assert.equal(parseNumber('1 234,5'), 1234.5);
  for (const bad of [null, undefined, '', 'abc', '12,3,4', NaN, Infinity, {}]) {
    assert.equal(parseNumber(bad), null, `parseNumber(${String(bad)})`);
  }
});

test('parseDate reads ISO dates, date-only and French dates as local time', () => {
  const local = new Date(2026, 9, 9);
  assert.equal(parseDate('2026-10-09T00:00:00').getTime(), local.getTime());
  assert.equal(parseDate('2026-10-09').getTime(), local.getTime());
  assert.equal(parseDate('09/10/2026').getTime(), local.getTime());
  assert.equal(parseDate('2026-10-11T11:45:38.38+02:00').toISOString(), '2026-10-11T09:45:38.380Z');
  for (const bad of [null, 42, '', 'yesterday', '2026-13-45T00:00:00']) {
    assert.equal(parseDate(bad), null, `parseDate(${String(bad)})`);
  }
});

test('readings come out oldest first, one per date, malformed ones dropped', () => {
  const readings = parseReadings({
    resultats: [
      ...READINGS.resultats,
      { valeurIndex: 'x', dateReleve: '2026-10-01T00:00:00' },
      { valeurIndex: 1, dateReleve: 'never' },
      { valeurIndex: -5, dateReleve: '2026-10-02T00:00:00' },
      { valeurIndex: '1 072,5', dateReleve: '2026-04-30T00:00:00' },
      null,
    ],
  });
  assert.deepEqual(
    readings.map(({ m3, consumptionM3, dailyAverageM3 }) => [m3, consumptionM3, dailyAverageM3]),
    [
      [81, null, null],
      [127, 46, 0.25136612021857924],
      [1072.5, null, null],
    ],
  );
  assert.ok(readings[0].date < readings[1].date);
  assert.deepEqual(parseReadings(null), []);
  assert.deepEqual(parseReadings({ resultats: 'nope' }), []);
});

test('the consumption of a reading comes in m³, else in liters, else not at all', () => {
  const consumptionOf = (fields) =>
    parseReadings({
      resultats: [{ dateReleve: '2026-04-30T00:00:00', valeurIndex: 10, ...fields }],
    })[0].consumptionM3;
  assert.equal(consumptionOf({ volumeConsoEnM3: '45,5', volumeConsoEnLitres: 1 }), 45.5);
  assert.equal(consumptionOf({ volumeConsoEnLitres: 45500 }), 45.5);
  assert.equal(consumptionOf({ volumeConsoEnM3: -3, volumeConsoEnLitres: 'n/a' }), null);
  assert.equal(consumptionOf({}), null);
});

test('invoices come out oldest first, malformed ones dropped', () => {
  const invoices = parseInvoices({
    resultats: [
      ...INVOICES.resultats,
      { montantTTCFacture: 10 },
      { dateEmissionFacture: '2026-01-01' },
    ],
  });
  assert.equal(invoices.length, 2);
  assert.deepEqual(invoices[0], {
    number: 'F2026-0001',
    amount: 87.65,
    issuedAt: new Date(2026, 2, 15),
    dueAt: new Date(2026, 3, 5),
  });
  assert.equal(invoices[1].amount, 98.76);
});

test('a contract merges its list entry with its details', () => {
  assert.deepEqual(parseContract(CONTRACTS.resultats[0], CONTRACT_DETAIL), {
    id: '1234567',
    owner: 'M. DUPONT JEAN',
    address: '1 RUE DE LA PAIX, RESIDENCE LES PINS, 64100 BAYONNE',
    meterSerial: 'I21FA123456',
  });
  // Without details, the list entry (single line here) is used.
  assert.equal(
    parseContract(CONTRACTS.resultats[0], null).address,
    '1 RUE DE LA PAIX 64100 BAYONNE',
  );
  assert.deepEqual(parseContract({ numeroContrat: 42 }, null), {
    id: '42',
    owner: null,
    address: null,
    meterSerial: null,
  });
});

test('list entries without a contract number are skipped', () => {
  const entries = contractEntries({
    resultats: [{ numeroContrat: '1' }, { numeroContrat: 2 }, { numeroContrat: ' ' }, {}, null],
  });
  assert.deepEqual(
    entries.map((entry) => entry.numeroContrat),
    ['1', 2],
  );
});

const clientOf = (fetchImpl) =>
  new AgurClient({ provider: PROVIDERS.agur, username: 'me', password: 'pw', fetchImpl });

test('fetchSnapshot reads every contract of the account', async () => {
  const snapshot = await fetchSnapshot(clientOf(createFakeFetch()));
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(snapshot.contracts.length, 1);
  const [contract] = snapshot.contracts;
  assert.equal(contract.id, '1234567');
  assert.equal(contract.meterSerial, 'I21FA123456');
  assert.equal(contract.readings.length, 3);
  assert.equal(contract.invoices.length, 2);
  assert.equal(contract.balance, -12.34);
});

test('an endpoint failing on its own only drops its part, with a warning', async () => {
  const snapshot = await fetchSnapshot(
    clientOf(
      createFakeFetch({
        '/Facture/listeFactures': () => ({ status: 500, body: {} }),
        '/Facturation/soldeComptableContratAbonnement/': () => ({ text: '<html></html>' }),
      }),
    ),
  );
  const [contract] = snapshot.contracts;
  assert.equal(contract.readings.length, 3);
  assert.deepEqual(contract.invoices, []);
  assert.equal(contract.balance, null);
  assert.equal(snapshot.warnings.length, 2);
  assert.match(snapshot.warnings[0], /contract 1234567 invoices: .*HTTP 500/);
});

test('a refused login or an unreachable Agur fails the whole snapshot', async () => {
  const client = {
    getContracts: async () => CONTRACTS,
    getContract: async () => CONTRACT_DETAIL,
    getReadings: async () => {
      throw new AgurError('unreachable', 'down');
    },
    getInvoices: async () => INVOICES,
    getBalance: async () => '0',
  };
  await assert.rejects(fetchSnapshot(client), { kind: 'unreachable' });

  await assert.rejects(
    fetchSnapshot({
      getContracts: async () => {
        throw new AgurError('http', 'down', { status: 503 });
      },
    }),
    { kind: 'http' },
  );
});
