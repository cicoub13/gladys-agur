// -----------------------------------------------------------------------------
// Self-scheduling polling loop.
//
// Borrowed from ../gladys-adguard-home/src/poller.js. A `setInterval` with an
// async body overlaps itself when a poll lasts longer than the period (here,
// the first publication of years of history). The next run is only scheduled
// once the previous one settled, and `refreshNow()` never runs two polls side
// by side: it waits for the one in flight, then runs a fresh one. The delay
// may be a function, read after each poll (shorter after a failure). Timers
// are injectable, like in lifecycle.js.
// -----------------------------------------------------------------------------

export class Poller {
  /**
   * @param {object} deps
   * @param {() => Promise<void>} deps.run - One poll; must not throw (errors are its own business).
   * @param {number|(() => number)} deps.intervalMs - Delay between the end of a poll and the
   * start of the next, or a function returning it.
   * @param {typeof setTimeout} [deps.setTimer] - Injectable timer, for tests.
   * @param {typeof clearTimeout} [deps.clearTimer] - Injectable timer, for tests.
   */
  constructor({ run, intervalMs, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.run = run;
    this.intervalMs = intervalMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.inFlight = null;
    this.stopped = true;
  }

  /**
   * Poll now, then every `intervalMs` after the previous poll settled.
   * @returns {Promise<void>} Settles once the first poll did.
   * @example
   * poller.start();
   */
  start() {
    this.stopped = false;
    return this.tick();
  }

  /**
   * Cancel the next poll; a poll in flight finishes but schedules nothing.
   * @returns {void}
   * @example
   * poller.stop();
   */
  stop() {
    this.stopped = true;
    this.cancelTimer();
  }

  /**
   * Poll as soon as possible, typically right after a command, so Gladys and
   * the widgets show its effect without waiting for the next period.
   * @returns {Promise<void>} Settles once the fresh poll did.
   * @example
   * await poller.refreshNow();
   */
  async refreshNow() {
    if (this.stopped) {
      return;
    }
    this.cancelTimer();
    // A loop, not an `if`: two commands in a row both wait here, and the
    // first one to resume starts the poll the second one must wait for.
    while (this.inFlight) {
      await this.inFlight;
    }
    if (this.stopped) {
      return;
    }
    // The poll we waited for may have scheduled the next one already.
    this.cancelTimer();
    await this.tick();
  }

  async tick() {
    let current = null;
    current = (async () => {
      try {
        await this.run();
      } finally {
        if (this.inFlight === current) {
          this.inFlight = null;
        }
      }
    })();
    this.inFlight = current;
    await current;
    if (!this.stopped && this.inFlight === null && this.timer === null) {
      this.timer = this.setTimer(
        () => {
          this.timer = null;
          this.tick();
        },
        typeof this.intervalMs === 'function' ? this.intervalMs() : this.intervalMs,
      );
    }
  }

  cancelTimer() {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
