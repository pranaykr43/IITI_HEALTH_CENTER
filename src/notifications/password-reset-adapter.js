function createUnconfiguredPasswordResetAdapter({ logger } = {}) {
  return {
    async deliver() {
      logger?.info?.({ component: 'password-reset' }, 'password reset delivery is not configured');
    },
  };
}

module.exports = { createUnconfiguredPasswordResetAdapter };
