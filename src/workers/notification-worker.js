const { createConsoleNotificationAdapter } = require('../notifications/console-adapter');

function createNotificationWorker({
  appointments,
  adapter = createConsoleNotificationAdapter(),
  logger = console,
  pollIntervalMs = 1_000,
  processOptions = {},
} = {}) {
  if (!appointments || typeof appointments.processOutboxOnce !== 'function') {
    throw new TypeError('appointments must provide processOutboxOnce(options)');
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('pollIntervalMs must be a positive integer');
  }

  let stopping = false;
  let loopPromise = null;
  let wakeWait = null;

  function waitForPoll() {
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        wakeWait = null;
        resolve();
      };
      const timer = setTimeout(finish, pollIntervalMs);
      wakeWait = finish;
    });
  }

  async function run() {
    while (!stopping) {
      try {
        const result = await appointments.processOutboxOnce({ ...processOptions, adapter });
        if (!result) await waitForPoll();
      } catch (error) {
        logger.error?.({ err: error }, 'notification worker iteration failed');
        await waitForPoll();
      }
    }
  }

  function start() {
    if (!loopPromise) {
      stopping = false;
      loopPromise = run();
    }
    return loopPromise;
  }

  async function stop() {
    stopping = true;
    wakeWait?.();
    if (loopPromise) await loopPromise;
  }

  return { start, stop };
}

module.exports = { createNotificationWorker };
