// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys from the `config_schema` of the manifest.
// This module only provides defaults, trims and coerces the types, and tells
// whether there is enough to log in.
//
// The host and the public application keys of the Agur customer portal (the
// ones the portal web page itself sends, not user secrets), from the Home
// Assistant integration this one is ported from
// (https://github.com/tbouron/ha-agur, custom_components/agur/const.py).
// ha-agur also lists Grand Paris Sud and Eau de Paris, which run the same
// portal software. Left out on purpose (October 2026): Grand Paris Sud refuses
// scripted requests (HTTP 412, "l'envoi de requêtes scriptées [...] est
// interdit"), and Eau de Paris was never tested with a real account.
// -----------------------------------------------------------------------------

export const PROVIDERS = Object.freeze({
  agur: {
    name: 'Agur',
    host: 'ael.agur.fr',
    clientId: 'AEL-TOKEN-AGR-PRD',
    accessKey: 'XX_fr-5DjklsdMM-AGR-PRD',
  },
});

export const DEFAULT_CONFIG = {
  provider: 'agur',
  username: '',
  password: '',
};

/**
 * Merge the user configuration with the defaults and coerce the types.
 * An unknown provider (stale or corrupted value) snaps back to Agur.
 * @param {Record<string, unknown>} [raw] - Configuration returned by the SDK.
 * @returns {{provider: string, username: string, password: string}} The normalized configuration.
 * @example
 * normalizeConfig({ provider: 'agur', username: ' me@example.com ', password: 's3cret' });
 */
export function normalizeConfig(raw) {
  // `= {}` would not cover an explicit null, which getConfig() can return.
  const source = raw ?? {};
  return {
    provider: Object.hasOwn(PROVIDERS, source.provider) ? source.provider : DEFAULT_CONFIG.provider,
    username: typeof source.username === 'string' ? source.username.trim() : '',
    password: typeof source.password === 'string' ? source.password : '',
  };
}

/**
 * Whether the configuration holds what is needed to log in.
 * @param {{username: string, password: string}} config - A normalized configuration.
 * @returns {boolean} True when both the username and the password are set.
 * @example
 * isConfigured(normalizeConfig(await gladys.getConfig()));
 */
export function isConfigured(config) {
  return config.username !== '' && config.password !== '';
}
