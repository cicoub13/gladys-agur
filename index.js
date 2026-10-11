// -----------------------------------------------------------------------------
// Entry point of the Agur external integration for Gladys Assistant.
//
// This file only WIRES the SDK to AgurIntegration (src/integration.js); it
// holds no logic. It:
//   1. instantiates the SDK (connection, auth, reconnection: handled for us);
//   2. registers every handler BEFORE connect();
//   3. (re)loads the configuration on every connection, with a retry.
//
// Environment variables provided by the Gladys supervisor:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// `new GladysIntegration()` reads them automatically.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { AgurIntegration } from './src/integration.js';
import { InitRetry, exitOnUnhandledRejection } from './src/lifecycle.js';

// Safety net: a rejection nobody handles is a bug. Log it where the user can
// see it, then exit so the Gladys supervisor restarts from a clean state.
exitOnUnhandledRejection({ logger });

const gladys = new GladysIntegration();
const integration = new AgurIntegration(gladys);

// --- Devices -----------------------------------------------------------------
gladys.onScanRequest(() => integration.handleScan());
// Not awaited: sending the history of a new device outlives the handler
// timeout (handleDeviceCreated logs its own failures).
gladys.onDeviceCreated(async (device) => {
  integration.handleDeviceCreated(device);
});
gladys.onDeviceUpdated(async (device) => {
  integration.handleDeviceCreated(device);
});
gladys.onDeviceDeleted(async (device) => integration.handleDeviceDeleted(device));

// --- Configuration screen ----------------------------------------------------
gladys.onAction('test_connection', () => integration.testConnection());

// Not awaited either: applyConfig settles after the first poll, which may
// send years of history. A poll never throws, it reports its own failures.
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  integration.applyConfig(newConfig).catch((err) => {
    logger.error('Could not apply the new configuration', err);
  });
});

// --- Connection lifecycle ----------------------------------------------------
// A failed initialization (host API not ready yet) is retried with backoff
// until it succeeds, instead of waiting for the next WebSocket reconnection.
// An unreachable Agur is NOT a failure here: the polling loop reports and
// retries it on its own.
const initRetry = new InitRetry({
  run: async () => integration.applyConfig(await gladys.getConfig()),
  onFailure: (err, delayMs) => {
    logger.error(`Initialization failed, retrying in ${Math.round(delayMs / 1000)}s`, err);
  },
});

gladys.on('connected', () => initRetry.start());

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(() => {
  initRetry.stop();
  integration.stop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Agur integration...');
// connect() only rejects when Gladys refuses the token on the first attempt;
// the SDK keeps reconnecting afterwards (the refusal can be transient, e.g.
// Gladys still booting), so stay alive instead of exiting.
gladys.connect().catch((err) => {
  logger.error('Initial connection failed, the SDK keeps retrying', err);
});
