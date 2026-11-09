function createConsoleNotificationAdapter({ write = console.log } = {}) {
  return {
    async deliver(event) {
      write(`[notification:local] ${event.eventType} for appointment ${event.aggregateId} (event ${event.eventId})`);
    },
  };
}

module.exports = { createConsoleNotificationAdapter };
