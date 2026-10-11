// -----------------------------------------------------------------------------
// State publication: only what Gladys has not received yet, under the host API
// rate limit.
//
// - Dated states (readings, invoices): a feature remembers the date of the
//   last state sent; only later ones go out. The first publication of a device
//   is therefore its whole history (up to three years of readings).
// - Undated states (amount due): sent when the value changed.
// - The host API takes at most 100 states per request and 300 per minute per
//   integration: batches of 100, spaced so that no rolling minute exceeds
//   `maxPerMinute` (kept below 300, the core counts in fixed windows).
// - Publications run one after the other: a poll and a device creation never
//   send the same states twice, nor exceed the rate together.
//
// Nothing is kept on disk: after a restart the history is sent again, and
// Gladys ignores the states it already has (same feature, date and value).
// -----------------------------------------------------------------------------

export const BATCH_SIZE = 100;
export const DEFAULT_MAX_PER_MINUTE = 250;
const MINUTE_MS = 60 * 1000;

export class StatePublisher {
  /**
   * @param {object} deps
   * @param {{publishStates: Function}} deps.gladys - The SDK client.
   * @param {number} [deps.maxPerMinute] - States allowed in any rolling minute.
   * @param {() => number} [deps.now] - Injectable clock, for tests.
   * @param {(ms: number) => Promise<void>} [deps.sleep] - Injectable wait, for tests.
   */
  constructor({
    gladys,
    maxPerMinute = DEFAULT_MAX_PER_MINUTE,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.gladys = gladys;
    this.maxPerMinute = maxPerMinute;
    this.now = now;
    this.sleep = sleep;
    // featureExternalId -> time (ms) of the last dated state sent.
    this.watermarks = new Map();
    // featureExternalId -> last undated value sent.
    this.lastValues = new Map();
    // [{ at, count }] of the batches sent in the last minute.
    this.sent = [];
    this.queue = Promise.resolve();
  }

  /**
   * Send the states Gladys has not received yet. Calls are queued.
   * @param {Array<{device_feature_external_id: string, state: number, created_at?: string}>} states - Dated
   * ones in chronological order per feature.
   * @param {object} [options]
   * @param {() => boolean} [options.isCancelled] - Checked before each batch: true stops quietly.
   * @returns {Promise<number>} How many states were sent.
   * @example
   * await publisher.publish(buildStates(gladys, contract));
   */
  publish(states, { isCancelled = () => false } = {}) {
    const run = this.queue.then(() => this.send(states, isCancelled));
    // A failure is the caller's to handle, not the next publication's.
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Forget what was sent for the features whose id starts with `prefix`, so
   * they are sent in full again (device created again after a deletion).
   * @param {string} prefix - Typically `<device external id>:`.
   * @returns {void}
   * @example
   * publisher.forget(`${device.external_id}:`);
   */
  forget(prefix) {
    for (const map of [this.watermarks, this.lastValues]) {
      for (const id of [...map.keys()]) {
        if (id.startsWith(prefix)) {
          map.delete(id);
        }
      }
    }
  }

  /** Forget everything (configuration changed). */
  reset() {
    this.watermarks.clear();
    this.lastValues.clear();
  }

  pending(states) {
    return states.filter(({ device_feature_external_id: id, state, created_at: createdAt }) => {
      if (createdAt === undefined) {
        return this.lastValues.get(id) !== state;
      }
      const watermark = this.watermarks.get(id);
      return watermark === undefined || Date.parse(createdAt) > watermark;
    });
  }

  async send(states, isCancelled) {
    const pending = this.pending(states);
    let count = 0;
    for (let index = 0; index < pending.length; index += BATCH_SIZE) {
      const batch = pending.slice(index, index + BATCH_SIZE);
      await this.waitForRoom(batch.length);
      if (isCancelled()) {
        break;
      }
      await this.gladys.publishStates(batch);
      this.sent.push({ at: this.now(), count: batch.length });
      // Recorded only once sent: a failed batch is sent again next time.
      for (const { device_feature_external_id: id, state, created_at: createdAt } of batch) {
        if (createdAt === undefined) {
          this.lastValues.set(id, state);
        } else {
          this.watermarks.set(id, Date.parse(createdAt));
        }
      }
      count += batch.length;
    }
    return count;
  }

  async waitForRoom(size) {
    for (;;) {
      const now = this.now();
      this.sent = this.sent.filter(({ at }) => now - at < MINUTE_MS);
      const used = this.sent.reduce((total, { count }) => total + count, 0);
      if (used + size <= this.maxPerMinute || this.sent.length === 0) {
        return;
      }
      await this.sleep(this.sent[0].at + MINUTE_MS - now);
    }
  }
}
