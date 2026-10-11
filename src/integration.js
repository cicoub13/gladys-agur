// -----------------------------------------------------------------------------
// The integration itself: owns the Agur client, the polling loop, the last
// snapshot and the state publisher, and answers every SDK handler from them.
// index.js only wires these methods to the SDK, so everything here runs
// against a fake Gladys and a fake client in the tests.
//
// Agur only exposes the billing readings (every few months) and the invoices:
// polling every 6 hours is plenty, and polite to a small portal. After a
// failure the next attempt comes sooner, except after a refused login.
// -----------------------------------------------------------------------------

import { logger as defaultLogger } from '@gladysassistant/integration-sdk';
import { PROVIDERS, isConfigured, normalizeConfig } from './config.js';
import { AgurClient, describeError } from './agur/client.js';
import { fetchSnapshot as defaultFetchSnapshot } from './agur/snapshot.js';
import { DEVICE_TYPE, buildDevice, buildStates, idsOf } from './devices.js';
import { Poller } from './poller.js';
import { StatePublisher } from './publisher.js';

export const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const RETRY_INTERVAL_MS = 30 * 60 * 1000;

const NOT_CONFIGURED = {
  en: 'Enter the email and password of your water account in the configuration.',
  fr: "Saisissez l'adresse e-mail et le mot de passe de votre compte eau dans la configuration.",
};

/**
 * Flatten a { en, fr } message into one string, for the places that only take
 * a string (a thrown Error shown under a button).
 * @param {{en: string, fr: string}} message - The bilingual message.
 * @returns {string} "English / Français".
 * @example
 * bilingual({ en: 'Unreachable', fr: 'Injoignable' }); // 'Unreachable / Injoignable'
 */
export function bilingual(message) {
  return `${message.en} / ${message.fr}`;
}

export class AgurIntegration {
  /**
   * @param {object} gladys - The GladysIntegration SDK instance.
   * @param {object} [deps] - Injectable collaborators, for tests.
   * @param {(config: object) => object} [deps.createClient] - Builds the Agur client of a config.
   * @param {typeof defaultFetchSnapshot} [deps.fetchSnapshot] - Reads everything the integration shows.
   * @param {object} [deps.publisher] - A StatePublisher.
   * @param {object} [deps.logger] - The SDK logger.
   * @param {typeof setTimeout} [deps.setTimer] - Injectable timer of the polling loop.
   * @param {typeof clearTimeout} [deps.clearTimer] - Injectable timer of the polling loop.
   */
  constructor(
    gladys,
    {
      createClient = (config) =>
        new AgurClient({
          provider: PROVIDERS[config.provider],
          username: config.username,
          password: config.password,
        }),
      fetchSnapshot = defaultFetchSnapshot,
      publisher = new StatePublisher({ gladys }),
      logger = defaultLogger,
      setTimer = setTimeout,
      clearTimer = clearTimeout,
    } = {},
  ) {
    this.gladys = gladys;
    this.createClient = createClient;
    this.fetchSnapshot = fetchSnapshot;
    this.publisher = publisher;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.config = normalizeConfig();
    this.client = null;
    this.poller = null;
    this.snapshot = null;
    // { en, fr } message of the last failed poll, null once a poll succeeds.
    this.lastError = null;
    // Reachability last reported to Gladys: null (never), true or false.
    this.reportedConnected = null;
    this.reportedReason = null;
    // Bumped on every config change: a poll started under an older config
    // must not publish anything once it resolves.
    this.generation = 0;
  }

  get portal() {
    return PROVIDERS[this.config.provider].name;
  }

  /**
   * (Re)start from a configuration: tears down the previous client and loop.
   * @param {Record<string, unknown>} rawConfig - The configuration from the SDK.
   * @returns {Promise<void>} Settles once the first poll did.
   * @example
   * await integration.applyConfig(await gladys.getConfig());
   */
  async applyConfig(rawConfig) {
    this.stop();
    this.generation += 1;
    const previous = this.config;
    this.config = normalizeConfig(rawConfig);
    this.client = null;
    this.snapshot = null;
    this.lastError = null;
    this.reportedConnected = null;
    this.reportedReason = null;
    // Every WebSocket reconnection applies the config again: only another
    // account needs its history sent from scratch.
    if (previous.provider !== this.config.provider || previous.username !== this.config.username) {
      this.publisher.reset();
    }

    if (!isConfigured(this.config)) {
      this.logger.info('Agur account not set');
      this.lastError = NOT_CONFIGURED;
      await this.reportConnection(false, this.lastError);
      return;
    }

    this.client = this.createClient(this.config);
    this.logger.info(`Polling ${this.portal} every ${POLL_INTERVAL_MS / 3_600_000} hours`);
    this.poller = new Poller({
      run: () => this.poll(),
      intervalMs: () => (this.lastError === null ? POLL_INTERVAL_MS : RETRY_INTERVAL_MS),
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    });
    await this.poller.start();
  }

  /**
   * One poll: read Agur, report reachability, publish the devices and the new
   * states. Never throws: a failure is logged and reported to Gladys.
   * @returns {Promise<void>}
   * @example
   * await integration.poll();
   */
  async poll() {
    const { generation, client } = this;
    let snapshot;
    try {
      snapshot = await this.fetchSnapshot(client);
    } catch (err) {
      if (generation === this.generation) {
        await this.handlePollFailure(err);
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.snapshot = snapshot;
    this.lastError = null;
    for (const warning of snapshot.warnings) {
      this.logger.warn(`Agur data partly unavailable: ${warning}`);
    }
    // Gladys-side failures (host API 429, WebSocket down) are not Agur
    // failures: logged, retried naturally by the next poll.
    try {
      if (this.reportedConnected !== true) {
        this.logger.info(
          `Connected to ${this.portal}: ${snapshot.contracts.length} contract(s) found`,
        );
      }
      await this.reportConnection(true);
      // Every poll: a new contract shows up in the Discovery tab without a
      // scan, and the params (meter serial) of created devices stay current.
      await this.publishDevices();
      await this.publishCreatedDevicesStates(generation);
    } catch (err) {
      this.logger.error('Could not publish to Gladys', err);
    }
  }

  async handlePollFailure(err) {
    this.lastError = describeError(err, this.portal);
    if (err?.kind === 'auth') {
      // Retrying a refused password every few hours could get the account
      // locked by the portal: wait for a config change or an explicit
      // "Test the connection" instead.
      this.poller?.stop();
      this.lastError = {
        en: `${this.lastError.en} Updates are suspended until then.`,
        fr: `${this.lastError.fr} Les mises à jour sont suspendues d'ici là.`,
      };
    }
    // Loud once per outage, quiet while it lasts.
    if (this.reportedConnected !== false) {
      this.logger.warn(`${this.portal} poll failed: ${this.lastError.en}`, err);
    } else {
      this.logger.debug(`${this.portal} still failing: ${this.lastError.en}`);
    }
    try {
      await this.reportConnection(false, this.lastError);
    } catch (statusErr) {
      this.logger.error('Could not report the connection status to Gladys', statusErr);
    }
  }

  /**
   * Report reachability to Gladys, only when it changed (a failure is sent
   * again when its reason changes: wrong password -> unreachable...).
   */
  async reportConnection(connected, message) {
    const reason = message?.en ?? null;
    if (this.reportedConnected === connected && this.reportedReason === reason) {
      return;
    }
    await this.gladys.setConnectionStatus(connected, message);
    this.reportedConnected = connected;
    this.reportedReason = reason;
  }

  async publishDevices() {
    await this.gladys.publishDiscoveredDevices(
      this.snapshot.contracts.map((contract) => buildDevice(this.gladys, contract, this.portal)),
    );
  }

  /**
   * Publish the new states of the devices the user created. States of devices
   * not created are dropped by the host API: sending years of history for
   * them would only burn the rate limit.
   */
  async publishCreatedDevicesStates(generation = this.generation) {
    if (!this.snapshot) {
      return;
    }
    const created = new Set(
      (await this.gladys.getDevices())
        .map((device) => device.external_id)
        .filter((id) => typeof id === 'string'),
    );
    const states = this.snapshot.contracts
      .filter((contract) => created.has(idsOf(this.gladys, contract.id).device))
      .flatMap((contract) => buildStates(this.gladys, contract));
    const sent = await this.publisher.publish(states, {
      isCancelled: () => generation !== this.generation,
    });
    if (sent > 0) {
      this.logger.info(`Published ${sent} state(s) to Gladys`);
    }
  }

  requireClient() {
    if (!this.client) {
      throw new Error(bilingual(NOT_CONFIGURED));
    }
    return this.client;
  }

  // --- SDK handlers ----------------------------------------------------------

  /**
   * onScanRequest: publish the devices of the last read. Without one yet, start
   * a read in the background (it publishes the devices itself) and say why
   * nothing is there: reading Agur takes longer than the 5 s of a handler.
   */
  async handleScan() {
    this.requireClient();
    if (this.snapshot) {
      await this.publishDevices();
      return;
    }
    if (this.poller?.stopped) {
      this.poller.start().catch(() => {});
    } else {
      this.poller?.refreshNow().catch(() => {});
    }
    if (this.lastError) {
      throw new Error(bilingual(this.lastError));
    }
  }

  /**
   * onDeviceCreated / onDeviceUpdated: states published before the user
   * created the device were dropped by the host API, so send its full history.
   * Not awaited: years of readings take minutes under the rate limit, far
   * beyond the 5 s the SDK gives a handler to answer.
   * @returns {Promise<void>} The background publication, for tests.
   */
  handleDeviceCreated(device) {
    if (this.isOurs(device)) {
      this.publisher.forget(`${device.external_id}:`);
    }
    return this.publishCreatedDevicesStates().catch((err) => {
      this.logger.error('Could not publish the history of the new device to Gladys', err);
    });
  }

  /** onDeviceDeleted: a device created again later must get its history again. */
  handleDeviceDeleted(device) {
    if (this.isOurs(device)) {
      this.publisher.forget(`${device.external_id}:`);
    }
  }

  isOurs(device) {
    return (
      typeof device?.external_id === 'string' &&
      device.external_id.startsWith(this.gladys.externalId(`${DEVICE_TYPE}:`))
    );
  }

  /** Manifest action `test_connection`: throws (shown in red) on failure. */
  async testConnection() {
    const client = this.requireClient();
    let contracts;
    try {
      await client.login();
      contracts = await client.getContracts();
    } catch (err) {
      throw new Error(bilingual(describeError(err, this.portal)), { cause: err });
    }
    const count = Array.isArray(contracts?.resultats) ? contracts.resultats.length : 0;
    // Also recovers right away after a fixed issue, including updates
    // suspended by a refused password (the credentials work again).
    if (this.poller?.stopped) {
      this.poller.start().catch(() => {});
    } else {
      this.poller?.refreshNow().catch(() => {});
    }
    return {
      en: `Connected to ${this.portal}: ${count} contract(s) found.`,
      fr: `Connecté à ${this.portal} : ${count} contrat(s) trouvé(s).`,
    };
  }

  /** Shutdown / config change: no timer left behind. */
  stop() {
    this.poller?.stop();
    this.poller = null;
  }
}
