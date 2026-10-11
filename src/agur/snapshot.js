// -----------------------------------------------------------------------------
// Everything the integration shows, read from Agur in one go.
//
// The API is private and undocumented: every field is checked, a missing or
// malformed one is dropped (never thrown), so one odd invoice cannot hide the
// meter readings. Field names come from the Home Assistant integration
// (https://github.com/tbouron/ha-agur, agur_client.py), checked against a real
// account in October 2026: the readings are the BILLING ones (every few
// months, not daily) and `valeurIndex` is in m³, not in liters as ha-agur says.
//
// Shape:
//   { contracts: [{ id, owner, address, meterSerial,
//                   readings: [{ date, m3, consumptionM3, dailyAverageM3 }], // oldest first
//                   invoices: [{ number, amount, issuedAt, dueAt }], // oldest first
//                   balance }],    // euros as Agur shows it (negative = due), or null
//     warnings: [string] }                                    // for the logs
// -----------------------------------------------------------------------------

/**
 * Read a number the API sends either as a JSON number or as a string, possibly
 * French-formatted ("1.234,56", "1 234,56").
 * @param {unknown} raw - The value.
 * @returns {number|null} The number, or null when it is not one.
 * @example
 * parseNumber('1.234,56'); // 1234.56
 */
export function parseNumber(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  // \s also covers the no-break spaces of French thousands separators.
  let text = raw.replace(/[\s€]/g, '');
  if (text.includes(',')) {
    // French format: dots group thousands, the comma is the decimal mark.
    text = text.replace(/\./g, '').replace(',', '.');
  }
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) {
    return null;
  }
  return Number(text);
}

/**
 * Read a date of the API: ISO 8601, with or without time and offset. A date
 * without offset is a local time of the portal, i.e. French time, which is the
 * time zone of Gladys (TZ) in practice.
 * @param {unknown} raw - The value.
 * @returns {Date|null} The date, or null when it is not one.
 * @example
 * parseDate('2026-10-09T00:00:00'); // local midnight
 */
export function parseDate(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  let text = raw.trim();
  const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (french) {
    text = `${french[3]}-${french[2]}-${french[1]}`;
  }
  // `new Date('2026-10-09')` would read UTC midnight, unlike a date-time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    text = `${text}T00:00:00`;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

const textOf = (raw) => (typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null);
const resultsOf = (body) => (Array.isArray(body?.resultats) ? body.resultats : []);

/**
 * What Agur says was consumed over the period of a reading, in m³:
 * `volumeConsoEnM3`, else `volumeConsoEnLitres`. Null when it says nothing
 * usable (the caller then works it out from the indexes).
 * @param {object} entry - Entry of getReadings.
 * @returns {number|null} The consumption in m³.
 */
function consumptionOf(entry) {
  const m3 = parseNumber(entry?.volumeConsoEnM3);
  if (m3 !== null && m3 >= 0) {
    return m3;
  }
  const liters = parseNumber(entry?.volumeConsoEnLitres);
  return liters !== null && liters >= 0 ? liters / 1000 : null;
}

/**
 * Meter readings, oldest first, one per date (the latest value wins). Entries
 * without an index are dropped: they are estimated flat rates ("Forfait
 * déductible"), deducted from a later reading, so counting them would count
 * that water twice.
 * @param {unknown} body - Answer of getReadings.
 * @returns {Array<{date: Date, m3: number, consumptionM3: number|null, dailyAverageM3: number|null}>} The
 * readings; `dailyAverageM3` is Agur's `moyenne`, the m³ per day over the period.
 */
export function parseReadings(body) {
  const byTime = new Map();
  for (const entry of resultsOf(body)) {
    const date = parseDate(entry?.dateReleve);
    const m3 = parseNumber(entry?.valeurIndex);
    if (date && m3 !== null && m3 >= 0) {
      const average = parseNumber(entry?.moyenne);
      byTime.set(date.getTime(), {
        date,
        m3,
        consumptionM3: consumptionOf(entry),
        dailyAverageM3: average !== null && average >= 0 ? average : null,
      });
    }
  }
  return [...byTime.values()].sort((a, b) => a.date - b.date);
}

/**
 * Invoices, oldest first.
 * @param {unknown} body - Answer of getInvoices.
 * @returns {Array<{number: string|null, amount: number, issuedAt: Date, dueAt: Date|null}>} The invoices.
 */
export function parseInvoices(body) {
  const invoices = [];
  for (const entry of resultsOf(body)) {
    const issuedAt = parseDate(entry?.dateEmissionFacture);
    const amount = parseNumber(entry?.montantTTCFacture);
    if (issuedAt && amount !== null) {
      invoices.push({
        number: textOf(entry?.numeroFactureClient),
        amount,
        issuedAt,
        dueAt: parseDate(entry?.dateLimitePaiementFacture),
      });
    }
  }
  return invoices.sort((a, b) => a.issuedAt - b.issuedAt);
}

/**
 * Contract number, owner, address and meter, from the list entry completed by
 * the detail answer (which carries the meter).
 * @param {object} listEntry - Entry of getContracts.
 * @param {unknown} detail - Answer of getContract, or null.
 * @returns {{id: string, owner: string|null, address: string|null, meterSerial: string|null}} The contract.
 */
export function parseContract(listEntry, detail) {
  const pick = (key) => textOf(detail?.[key]) ?? textOf(listEntry?.[key]);
  // The address comes as several lines (street, residence, postcode and city).
  const address = pick('adresseLivraisonConstruite');
  return {
    id: String(listEntry.numeroContrat).trim(),
    owner: pick('nomClientTitulaire'),
    address:
      address === null
        ? null
        : address
            .split(/\s*[\r\n]+\s*/)
            .map((line) => line.replace(/\s+/g, ' '))
            .join(', '),
    meterSerial: pick('numeroPhysiqueAppareil'),
  };
}

/**
 * The contract numbers of the account, in the order Agur lists them.
 * @param {unknown} body - Answer of getContracts.
 * @returns {object[]} The list entries that carry a contract number.
 */
export function contractEntries(body) {
  return resultsOf(body).filter((entry) => {
    const id = entry?.numeroContrat;
    return (typeof id === 'string' && id.trim() !== '') || Number.isInteger(id);
  });
}

// Failures that only concern one endpoint (an Agur bug on one contract type,
// a field it stopped sending): the rest of the snapshot is still worth it. An
// unreachable Agur or a refused login fails the whole poll instead.
const PARTIAL_KINDS = new Set(['http', 'invalid_response']);

async function optional(promise, warnings, what) {
  try {
    return await promise;
  } catch (err) {
    if (err?.name === 'AgurError' && PARTIAL_KINDS.has(err.kind)) {
      warnings.push(`${what}: ${err.message}`);
      return null;
    }
    throw err;
  }
}

/**
 * Read every contract of the account with its readings, invoices and balance.
 * @param {import('./client.js').AgurClient} client - A logged-in or loggable client.
 * @returns {Promise<{contracts: object[], warnings: string[]}>} The snapshot.
 * @throws {import('./client.js').AgurError} When the contract list cannot be read.
 * @example
 * const { contracts } = await fetchSnapshot(client);
 */
export async function fetchSnapshot(client) {
  const warnings = [];
  const entries = contractEntries(await client.getContracts());
  const contracts = [];
  // One contract after the other (a household has one or two), the four reads
  // of a contract side by side, as the portal page itself does.
  for (const entry of entries) {
    const id = String(entry.numeroContrat).trim();
    const [detail, readings, invoices, balance] = await Promise.all([
      optional(client.getContract(id), warnings, `contract ${id} details`),
      optional(client.getReadings(id), warnings, `contract ${id} readings`),
      optional(client.getInvoices(id), warnings, `contract ${id} invoices`),
      optional(client.getBalance(id), warnings, `contract ${id} balance`),
    ]);
    contracts.push({
      ...parseContract(entry, detail),
      readings: parseReadings(readings),
      invoices: parseInvoices(invoices),
      balance: parseNumber(balance),
    });
  }
  return { contracts, warnings };
}
