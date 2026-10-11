// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys from the `config_schema` of the manifest.
// This module only provides defaults, trims and coerces the types, and tells
// whether there is enough to log in.
//
// Agur runs the customer portal of several water utilities on the same
// platform: each one has its own host and its own public application keys
// (the ones the portal web page itself sends, not user secrets). Same list as
// the Home Assistant integration this one is ported from
// (https://github.com/tbouron/ha-agur, custom_components/agur/const.py).
// -----------------------------------------------------------------------------

export const PROVIDERS = Object.freeze({
  agur: {
    name: 'Agur',
    host: 'ael.agur.fr',
    clientId: 'AEL-TOKEN-AGR-PRD',
    accessKey: 'XX_fr-5DjklsdMM-AGR-PRD',
  },
  grandparissud: {
    name: 'Grand Paris Sud',
    host: 'abonne-eau.grandparissud.fr',
    clientId: 'AEL-TOKEN-GPS-PRD',
    accessKey: 'REGPS-hc-GPS-MP-PRD',
  },
  eauparis: {
    name: 'Eau de Paris',
    host: 'agence.eaudeparis.fr',
    clientId: 'AEL-TOKEN-EDP-PRD',
    accessKey: 'EDP-2-hjkUyGHT-M-PRD',
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
