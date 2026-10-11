// -----------------------------------------------------------------------------
// Manual end-to-end check against the REAL Agur API, without Gladys.
//
// Logs in, reads every contract like a poll does, and prints what the
// integration would publish, plus the field names of each raw answer: the
// data payloads were ported from ha-agur and never checked against a real
// account, this is how to spot a field Agur renamed. Prints personal data
// (address, readings) to the terminal only.
//
// Usage: put your credentials in .env (ignored by git), then `npm run smoke`.
//   AGUR_USERNAME=...   email of the customer website
//   AGUR_PASSWORD=...   password
// -----------------------------------------------------------------------------

import { AgurClient, describeError } from '../src/agur/client.js';
import { fetchSnapshot } from '../src/agur/snapshot.js';
import { PROVIDERS, normalizeConfig } from '../src/config.js';
import { buildDevice, buildStates } from '../src/devices.js';

const config = normalizeConfig({
  username: process.env.AGUR_USERNAME,
  password: process.env.AGUR_PASSWORD,
});
if (!config.username || !config.password) {
  console.error('Set AGUR_USERNAME and AGUR_PASSWORD in .env, then run `npm run smoke`.');
  process.exit(1);
}

const provider = PROVIDERS[config.provider];
const client = new AgurClient({ provider, username: config.username, password: config.password });
const gladys = {
  externalIds: (type, platformId) => {
    const device = `ext:smoke:${type}:${platformId}`;
    return { device, feature: (key) => `${device}:${key}` };
  },
};
const keysOf = (body) => {
  const first = Array.isArray(body?.resultats) ? body.resultats[0] : body;
  return first !== null && typeof first === 'object' ? Object.keys(first).join(', ') : typeof first;
};

try {
  console.log(`Logging in to ${provider.name} (${provider.host})...`);
  await client.login();
  console.log(`  session valid until ${new Date(client.sessionExpiresAt).toLocaleString()}`);

  const snapshot = await fetchSnapshot(client);
  for (const warning of snapshot.warnings) {
    console.log(`  [warn] ${warning}`);
  }
  console.log(`${snapshot.contracts.length} contract(s)`);

  for (const contract of snapshot.contracts) {
    const device = buildDevice(gladys, contract, provider.name);
    const states = buildStates(gladys, contract);
    const { readings, invoices } = contract;
    console.log(`\n== ${device.name} (contract ${contract.id})`);
    console.log(`  address: ${contract.address ?? '-'}`);
    console.log(`  readings: ${readings.length} (index, consumption by Agur, index difference)`);
    readings.forEach((reading, index) => {
      const previous = readings[index - 1];
      const difference = previous ? (reading.m3 - previous.m3).toFixed(3) : '-';
      console.log(
        `    ${reading.date.toLocaleDateString()}  ${reading.m3} m³  ${reading.consumptionM3 ?? '-'} m³  ${difference} m³`,
      );
    });
    console.log(`  invoices: ${invoices.length}`);
    for (const invoice of invoices.slice(-2)) {
      console.log(
        `    ${invoice.issuedAt.toLocaleDateString()}  ${invoice.amount} €  ${invoice.number ?? ''}`,
      );
    }
    console.log(`  balance: ${contract.balance ?? '-'} €`);
    console.log(`  states to publish: ${states.length}`);

    console.log('  raw field names:');
    const raw = {
      detail: await client.getContract(contract.id),
      readings: await client.getReadings(contract.id),
      invoices: await client.getInvoices(contract.id),
      balance: await client.getBalance(contract.id),
    };
    for (const [name, body] of Object.entries(raw)) {
      console.log(`    ${name}: ${name === 'balance' ? JSON.stringify(body) : keysOf(body)}`);
    }
    console.log(`  reading frequency: ${raw.detail?.libelleRythmeReleve ?? '-'}`);
    console.log('  raw readings (newest first):');
    for (const entry of (raw.readings?.resultats ?? []).slice(0, 4)) {
      const { dateReleve, valeurIndex, volumeConsoEnLitres, volumeConsoEnM3, moyenne } = entry;
      const { libelleOrigineReleve, libelleAnomalieReleve } = entry;
      console.log(
        `    ${JSON.stringify({ dateReleve, valeurIndex, volumeConsoEnLitres, volumeConsoEnM3, moyenne, libelleOrigineReleve, libelleAnomalieReleve })}`,
      );
    }
  }
} catch (err) {
  console.error(`\nFailed: ${describeError(err, provider.name).en}`);
  console.error(`  ${err.message}`);
  process.exit(1);
}
