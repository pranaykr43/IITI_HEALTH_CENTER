const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { openDatabase } = require('../db');
const { loadConfig } = require('../config');
const { AppError } = require('../errors');
const { createAppointmentService } = require('../services/appointment-service');
const { createAuthService } = require('../services/auth-service');
const { createAccountService } = require('../services/account-service');
const { createPasswordResetService } = require('../services/password-reset-service');
const { createGoogleOAuthService } = require('../services/google-oauth-service');
const { createHousekeepingService } = require('../services/housekeeping-service');
const { createMfaService } = require('../services/mfa-service');
const { formatClinicDateTime, clinicDateParts } = require('../domain/clinic-time');
const { createInsightsService } = require('../services/insights-service');
const { createAuditService } = require('../services/audit-service');
const { createUnconfiguredPasswordResetAdapter, createResendPasswordResetAdapter } = require('../notifications/password-reset-adapter');
const { createRouter, wantsJson, safeEqual } = require('./routes');

function createApp(options = {}) {
  const config = loadConfig(options.config || {});
  const db = options.db || openDatabase(config.dbPath);
  const logger = options.logger || pino({ level: config.logLevel, redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-csrf-token', 'req.headers.set-cookie', 'password', 'token', 'resetUrl'], censor: '[REDACTED]' } });
  const auth = createAuthService(db, config);
  const passwordResetAdapter = options.passwordResetAdapter || (config.emailEnabled
    ? createResendPasswordResetAdapter({ apiKey: config.resendApiKey, from: config.emailFrom })
    : createUnconfiguredPasswordResetAdapter({ logger }));
  const routesConfig = { ...config, emailEnabled: passwordResetAdapter.configured ?? config.emailEnabled };
  const accounts = createAccountService({ db, auth, protectedEmails: config.demoProtectedEmails });
  const googleOAuth = createGoogleOAuthService({ db, config, oauthClientFactory: options.oauthClientFactory });
  const passwordResets = createPasswordResetService({
    db,
    adapter: passwordResetAdapter,
    reportDeliveryFailure: () => logger.warn({ component: 'password-reset' }, 'password reset delivery adapter failed'),
  });
  const appointments = createAppointmentService(db, { clinicTimeZone: config.clinicTimeZone, slotMinutes: config.slotMinutes });
  const housekeeping = createHousekeepingService(db);
  const mfa = createMfaService({ db, config, now: options.now });
  const insights = createInsightsService(db, { clinicTimeZone: config.clinicTimeZone, slotMinutes: config.slotMinutes, now: options.now });
  const audit = createAuditService(db);
  if (config.mfaEncryptionKeyIsDevelopmentDefault && config.nodeEnv === 'development') {
    logger.warn({ component: 'mfa' }, 'MFA_ENCRYPTION_KEY is not set; using the insecure development key');
  }
  const metrics = { requests: 0, errors: 0, appointmentsCreated: 0, startedAt: new Date().toISOString() };
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.appName = 'Health Centre';
  app.locals.metrics = metrics;
  app.locals.clinicTimeZone = config.clinicTimeZone;
  app.locals.slotMinutes = config.slotMinutes;
  app.locals.formatDateTime = (value) => formatClinicDateTime(value, config.clinicTimeZone);
  app.locals.clinicDateParts = (value) => clinicDateParts(value, config.clinicTimeZone);
  app.locals.clinicZoneLabel = config.clinicTimeZone === 'Asia/Kolkata' ? 'IST' : config.clinicTimeZone;

  app.use(helmet({
    strictTransportSecurity: config.nodeEnv === 'production' ? undefined : false,
    contentSecurityPolicy: {
      directives: {
        'upgrade-insecure-requests': config.nodeEnv === 'production' ? [] : null,
      },
    },
  }));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.nodeEnv === 'production' ? '1d' : 0 }));
  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.get('x-request-id') || crypto.randomUUID(),
    serializers: {
      req(req) {
        const serialized = pino.stdSerializers.req(req);
        serialized.url = String(serialized.url || '').split('?')[0];
        return serialized;
      },
    },
  }));
  app.use((req, res, next) => {
    req.id = req.id || res.getHeader('x-request-id') || crypto.randomUUID();
    res.setHeader('x-request-id', req.id);
    metrics.requests += 1;
    res.on('finish', () => {
      if (res.statusCode >= 500) metrics.errors += 1;
    });
    next();
  });
  app.use(rateLimit({
    windowMs: 60_000,
    limit: options.rateLimitLimit ?? 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }));
  app.use((req, res, next) => {
    req.session = auth.getSession(req.cookies.health_session);
    next();
  });

  app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok', service: 'health-centre' }));
  app.get('/readyz', (req, res) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      return res.status(200).json({ status: 'ready', database: 'ok' });
    } catch (error) {
      return res.status(503).json({ status: 'not_ready', database: 'unavailable', requestId: req.id });
    }
  });
  // Metrics reveal operational state. In production they are served only to a scraper
  // presenting METRICS_TOKEN; without a token configured the endpoint does not exist.
  app.get('/metrics', (req, res, next) => {
    if (config.metricsToken) {
      const presented = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!safeEqual(presented, config.metricsToken)) {
        res.set('WWW-Authenticate', 'Bearer realm="metrics"');
        return res.status(401).json({ error: 'authentication_required', message: 'Metrics token required', requestId: req.id });
      }
    } else if (config.nodeEnv === 'production') {
      return next();
    }
    const uptimeSeconds = Math.floor(process.uptime());
    const outbox = appointments.getOutboxMetrics();
    const heartbeatAgeSeconds = outbox.workerLastSeenAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(outbox.workerLastSeenAt)) / 1000))
      : -1;
    res.type('text/plain').send([
      '# HELP health_centre_http_requests_total Total HTTP requests observed.',
      '# TYPE health_centre_http_requests_total counter',
      `health_centre_http_requests_total ${metrics.requests}`,
      '# HELP health_centre_http_errors_total Total HTTP 5xx responses.',
      '# TYPE health_centre_http_errors_total counter',
      `health_centre_http_errors_total ${metrics.errors}`,
      '# HELP health_centre_appointments_created_total Appointments created, excluding idempotent replays.',
      '# TYPE health_centre_appointments_created_total counter',
      `health_centre_appointments_created_total ${metrics.appointmentsCreated}`,
      '# HELP health_centre_process_uptime_seconds Process uptime.',
      '# TYPE health_centre_process_uptime_seconds gauge',
      `health_centre_process_uptime_seconds ${uptimeSeconds}`,
      '# HELP health_centre_outbox_events Notification outbox events by status.',
      '# TYPE health_centre_outbox_events gauge',
      ...['pending', 'processing', 'failed', 'dead'].map((status) => `health_centre_outbox_events{status="${status}"} ${outbox[status]}`),
      '# HELP health_centre_outbox_oldest_pending_age_seconds Age of the oldest pending notification event.',
      '# TYPE health_centre_outbox_oldest_pending_age_seconds gauge',
      `health_centre_outbox_oldest_pending_age_seconds ${outbox.oldestPendingAgeSeconds}`,
      '# HELP health_centre_worker_heartbeat_age_seconds Seconds since the notification worker last polled; -1 if never seen.',
      '# TYPE health_centre_worker_heartbeat_age_seconds gauge',
      `health_centre_worker_heartbeat_age_seconds ${heartbeatAgeSeconds}`,
    ].join('\n') + '\n');
  });

  if (typeof options.e2eShutdown === 'function') {
    app.post('/__e2e/shutdown', (req, res) => {
      res.status(204).end();
      setImmediate(options.e2eShutdown);
    });
    if (typeof options.resetE2ERedriveFixture === 'function') {
      app.post('/__e2e/reset-redrive-fixture', (req, res) => {
        options.resetE2ERedriveFixture();
        return res.status(204).end();
      });
    }
    if (typeof options.getE2EPasswordResetLink === 'function') {
      app.get('/__e2e/password-reset-link', (req, res) => {
        const link = options.getE2EPasswordResetLink(String(req.query.email || '').trim().toLowerCase());
        if (!link) return res.status(404).json({ error: 'not_found' });
        return res.json({ link });
      });
    }
  }

  app.use(createRouter({ auth, appointments, accounts, passwordResets, googleOAuth, mfa, insights, audit, metrics, config: routesConfig, options }));

  app.use((req, res) => {
    const error = new AppError('Route not found', 404, 'not_found');
    if (wantsJson(req)) return res.status(404).json({ error: error.code, message: error.message, requestId: req.id });
    return res.status(404).render('error', { title: 'Not found', error });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const isAppError = err instanceof AppError;
    const statusCode = isAppError ? err.statusCode : 500;
    const payload = {
      error: isAppError ? err.code : 'internal_error',
      message: isAppError ? err.message : 'Unexpected server error',
      details: isAppError ? err.details : undefined,
      requestId: req.id,
    };
    req.log?.error({ err, requestId: req.id, statusCode }, 'request failed');
    if (wantsJson(req)) return res.status(statusCode).json(payload);
    return res.status(statusCode).render('error', { title: 'Request failed', error: payload });
  });

  return { app, db, auth, accounts, passwordResets, googleOAuth, appointments, housekeeping, mfa, config, metrics, logger, close: () => db.close() };
}

module.exports = { createApp };
