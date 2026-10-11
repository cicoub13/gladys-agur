// -----------------------------------------------------------------------------
// Mapping between an Agur contract and a Gladys device.
//
// One device per contract, identified by the contract number: it survives a
// meter replacement (the meter serial changes, the contract does not) and a
// change of the account email. Never derive the ids from anything else, or
// every device users created (and its history) is orphaned.
//
// Features, all read-only sensors with history:
//   - meter index (volume-sensor/decimal, m³): the cumulative reading, dated
//     with the reading date;
//   - consumption (volume-sensor/decimal, m³): what was used between a
//     reading and the previous one, dated with the reading date. Readings are
//     the billing ones, so a period is usually a few months;
//   - daily average (volume-sensor/integer, liters): the average consumption
//     per day over that period (Agur's `moyenne`), the only figure comparable
//     from one period to the next (they do not last the same);
//   - invoice (currency/decimal, euros): the amount of each invoice, dated
//     with its issue date, so the last value is the latest invoice;
//   - amount due (currency/decimal, euros): the accounting balance of the
//     contract with its sign flipped, so that positive means "to pay"
//     (Agur shows what is due as a negative balance), undated (it is "now").
// Readings and invoices are published with their own dates (`created_at`):
// Gladys files them in the history at the right place and keeps the most
// recent one as the current value.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'water-meter';

// Feature keys (suffix of the feature external_id). Stable: renaming one
// orphans the feature in Gladys.
export const FEATURE_KEYS = Object.freeze({
  INDEX: 'index',
  CONSUMPTION: 'consumption',
  DAILY_AVERAGE: 'daily_average',
  INVOICE: 'invoice',
  AMOUNT_DUE: 'amount_due',
});

const sensor = (definition) => ({
  ...definition,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});

// Order = display order in Gladys.
const FEATURES = [
  {
    key: FEATURE_KEYS.INDEX,
    definition: sensor({
      name: 'Meter index',
      category: DEVICE_FEATURE_CATEGORIES.VOLUME_SENSOR,
      type: DEVICE_FEATURE_TYPES.VOLUME_SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CUBIC_METER,
      min: 0,
      max: 1_000_000,
    }),
  },
  {
    key: FEATURE_KEYS.CONSUMPTION,
    definition: sensor({
      name: 'Consumption since previous reading',
      category: DEVICE_FEATURE_CATEGORIES.VOLUME_SENSOR,
      type: DEVICE_FEATURE_TYPES.VOLUME_SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CUBIC_METER,
      min: 0,
      max: 100_000,
    }),
  },
  {
    key: FEATURE_KEYS.DAILY_AVERAGE,
    definition: sensor({
      name: 'Average daily consumption',
      category: DEVICE_FEATURE_CATEGORIES.VOLUME_SENSOR,
      type: DEVICE_FEATURE_TYPES.VOLUME_SENSOR.INTEGER,
      unit: DEVICE_FEATURE_UNITS.LITER,
      min: 0,
      max: 100_000,
    }),
  },
  {
    key: FEATURE_KEYS.INVOICE,
    definition: sensor({
      name: 'Invoice amount',
      category: DEVICE_FEATURE_CATEGORIES.CURRENCY,
      type: DEVICE_FEATURE_TYPES.CURRENCY.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.EURO,
      // A credit note is negative.
      min: -100_000,
      max: 100_000,
    }),
  },
  {
    key: FEATURE_KEYS.AMOUNT_DUE,
    definition: sensor({
      // Negative: money in the customer's favour.
      name: 'Amount due',
      category: DEVICE_FEATURE_CATEGORIES.CURRENCY,
      type: DEVICE_FEATURE_TYPES.CURRENCY.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.EURO,
      min: -100_000,
      max: 100_000,
    }),
  },
];

const round = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;

/**
 * The external ids of the device of a contract.
 * @param {{externalIds: Function}} gladys - The SDK client.
 * @param {string} contractId - Contract number.
 * @returns {{device: string, feature: (key: string) => string}} The ids.
 * @example
 * idsOf(gladys, '1234567').feature('index');
 */
export function idsOf(gladys, contractId) {
  return gladys.externalIds(DEVICE_TYPE, contractId);
}

/**
 * Build the discovery payload of the device of a contract.
 * @param {{externalIds: Function}} gladys - The SDK client.
 * @param {object} contract - A contract of the snapshot.
 * @param {string} portal - Name of the water utility, e.g. 'Agur'.
 * @returns {object} Device for publishDiscoveredDevices.
 * @example
 * await gladys.publishDiscoveredDevices(contracts.map((c) => buildDevice(gladys, c, 'Agur')));
 */
export function buildDevice(gladys, contract, portal) {
  const ids = idsOf(gladys, contract.id);
  const params = [
    ['CONTRACT_NUMBER', contract.id],
    ['METER_SERIAL_NUMBER', contract.meterSerial],
    ['ADDRESS', contract.address],
  ]
    .filter(([, value]) => value)
    .map(([name, value]) => ({ name, value }));
  return {
    name: `${portal} ${contract.meterSerial ?? contract.id}`,
    external_id: ids.device,
    params,
    features: FEATURES.map(({ key, definition }) => ({
      ...definition,
      external_id: ids.feature(key),
    })),
  };
}

/**
 * Every state of the device of a contract, dated ones oldest first.
 * @param {{externalIds: Function}} gladys - The SDK client.
 * @param {object} contract - A contract of the snapshot.
 * @returns {Array<{device_feature_external_id: string, state: number, created_at?: string}>} The states.
 * @example
 * buildStates(gladys, contract);
 */
export function buildStates(gladys, contract) {
  const ids = idsOf(gladys, contract.id);
  const states = [];
  const dated = (key, state, date) => ({
    device_feature_external_id: ids.feature(key),
    state,
    created_at: date.toISOString(),
  });

  contract.readings.forEach((reading, index) => {
    states.push(dated(FEATURE_KEYS.INDEX, round(reading.m3, 3), reading.date));
    // The consumption Agur bills is the reference (it knows about meter
    // changes and estimated readings); the index difference is the fallback.
    let consumption = reading.consumptionM3;
    const previous = contract.readings[index - 1];
    // A lower index means a new meter: no consumption can be told for it.
    if (consumption === null && previous && reading.m3 >= previous.m3) {
      consumption = reading.m3 - previous.m3;
    }
    if (consumption !== null) {
      states.push(dated(FEATURE_KEYS.CONSUMPTION, round(consumption, 3), reading.date));
    }
    if (reading.dailyAverageM3 !== null) {
      states.push(
        dated(FEATURE_KEYS.DAILY_AVERAGE, Math.round(reading.dailyAverageM3 * 1000), reading.date),
      );
    }
  });
  for (const invoice of contract.invoices) {
    states.push(dated(FEATURE_KEYS.INVOICE, round(invoice.amount, 2), invoice.issuedAt));
  }
  if (contract.balance !== null) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE_KEYS.AMOUNT_DUE),
      // `|| 0`: a zero balance must not become -0.
      state: round(-contract.balance, 2) || 0,
    });
  }
  return states;
}
