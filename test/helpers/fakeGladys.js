// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
// Reproduces only the surface the integration relies on, recording every call
// (pattern borrowed from ../gladys-adguard-home/test/helpers/fakeGladys.js).
// The external ids follow the SDK format `ext:<selector>:<type>:<platformId>[:<key>]`.
// -----------------------------------------------------------------------------

export function createFakeGladys({ devices = [] } = {}) {
  const calls = {
    states: [],
    batches: [],
    discovered: [],
    connectionStatuses: [],
  };
  const failures = {};

  function maybeFail(method) {
    if (failures[method] > 0) {
      failures[method] -= 1;
      const err = new Error('Too Many Requests');
      err.status = 429;
      throw err;
    }
  }

  return {
    calls,
    /** Devices the user created, as getDevices() returns them. */
    devices,

    /** The next `times` calls of `method` reject like a host API 429. */
    failNext(method, times = 1) {
      failures[method] = times;
    },

    externalIds(type, platformId) {
      const device = `ext:test:${type}:${platformId}`;
      return { device, feature: (key) => `${device}:${key}` };
    },

    externalId(suffix) {
      return `ext:test:${suffix}`;
    },

    async publishStates(states) {
      maybeFail('publishStates');
      calls.batches.push(states.length);
      calls.states.push(...states);
    },

    async publishDiscoveredDevices(list) {
      maybeFail('publishDiscoveredDevices');
      calls.discovered.push(list);
    },

    async setConnectionStatus(connected, message) {
      maybeFail('setConnectionStatus');
      calls.connectionStatuses.push({ connected, message });
    },

    async getDevices() {
      maybeFail('getDevices');
      return this.devices;
    },
  };
}
