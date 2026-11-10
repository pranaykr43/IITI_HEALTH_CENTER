const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
} = require('../errors');

const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
});

const scheduleSchema = z.object({
  doctorId: z.coerce.number().int().positive(),
  scheduledFor: z.string().min(1).max(64),
});

const completionSchema = z.object({
  test: z.string().trim().max(500).optional().default(''),
  medicine: z.string().trim().max(2000).optional().default(''),
  advice: z.string().trim().max(2000).optional().default(''),
});

const accountSchema = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(200),
  role: z.enum(['patient', 'doctor']),
  qualification: z.string().trim().max(120).optional(),
  specialization: z.string().trim().max(120).optional(),
  availableDays: z.string().trim().max(120).optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
});

const adminAccountSchema = accountSchema.extend({ role: z.literal('admin'), confirmAdminCreation: z.literal('yes') });
const redriveSchema = z.object({ reason: z.string().trim().min(10).max(500) });
const resetRequestSchema = z.object({ email: z.string().trim().email().max(320) });
const resetCompletionSchema = z.object({
  token: z.string().min(32).max(100),
  password: z.string().min(12).max(200),
  confirmPassword: z.string().min(12).max(200),
}).refine((input) => input.password === input.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

function wantsJson(req) {
  return req.path.startsWith('/api') || (req.accepts('html') !== 'html' && req.accepts('json') === 'json');
}

function safeParse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('Request validation failed', result.error.flatten());
  }
  return result.data;
}

function createRouter({ auth, appointments, accounts, passwordResets, metrics, config, options = {} }) {
  const router = express.Router();
  const passwordResetRequestLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: options.passwordResetRequestLimit ?? 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Please wait before requesting another password reset.' },
  });
  const passwordResetCompletionLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: options.passwordResetCompletionLimit ?? 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Please wait before trying another password reset.' },
  });

  const requireAuth = (req, res, next) => {
    if (!req.session) {
      if (wantsJson(req)) return next(new AuthenticationError());
      return res.redirect('/login');
    }
    return next();
  };

  const requireRole = (...roles) => (req, res, next) => {
    if (!req.session) return next(new AuthenticationError());
    if (!roles.includes(req.session.user.role)) return next(new AuthorizationError());
    return next();
  };

  const requireCsrf = (req, res, next) => {
    if (!req.session) return next(new AuthenticationError());
    const token = req.get('x-csrf-token') || req.body._csrf;
    if (!token || token !== req.session.csrfToken) return next(new AuthorizationError('Invalid CSRF token'));
    return next();
  };

  const renderOrJson = (req, res, view, model, statusCode = 200) => {
    if (wantsJson(req)) return res.status(statusCode).json(model);
    return res.status(statusCode).render(view, model);
  };

  router.use((req, res, next) => {
    res.locals.currentUser = req.session ? req.session.user : null;
    res.locals.csrfToken = req.session ? req.session.csrfToken : '';
    res.locals.requestId = req.id;
    next();
  });

  router.get('/', (req, res) => res.render('home', { title: 'Health Centre' }));

  router.get('/login', (req, res) => {
    if (req.session) return res.redirect('/dashboard');
    return res.render('login', { title: 'Sign in', error: null, message: req.query.message || null });
  });

  router.get('/password/forgot', (req, res) => res.render('password-forgot', {
    title: 'Reset password', sent: false, error: null,
  }));
  router.post('/password/forgot', passwordResetRequestLimiter, async (req, res, next) => {
    try {
      const { email } = safeParse(resetRequestSchema, req.body);
      const baseUrl = config.publicBaseUrl || `http://127.0.0.1:${config.port}`;
      await passwordResets.requestReset(email, baseUrl);
      return res.status(200).render('password-forgot', { title: 'Reset password', sent: true, error: null });
    } catch (error) {
      if (!wantsJson(req) && error instanceof AppError) {
        return res.status(error.statusCode).render('password-forgot', { title: 'Reset password', sent: false, error: error.message });
      }
      return next(error);
    }
  });
  router.get('/password/reset', (req, res) => res.render('password-reset', {
    title: 'Choose a new password', token: String(req.query.token || ''), error: null,
  }));
  router.post('/password/reset', passwordResetCompletionLimiter, (req, res, next) => {
    try {
      const input = safeParse(resetCompletionSchema, req.body);
      const reset = passwordResets.completeReset(input.token, input.password);
      if (!reset) {
        return res.status(400).render('password-reset', {
          title: 'Choose a new password', token: '', error: 'This reset link is invalid or expired. Request another link.',
        });
      }
      if (wantsJson(req)) return res.status(200).json({ message: 'Password changed. Sign in again.' });
      return res.redirect('/login?message=Password%20changed.%20Sign%20in%20again.');
    } catch (error) {
      if (!wantsJson(req) && error instanceof AppError) {
        return res.status(error.statusCode).render('password-reset', {
          title: 'Choose a new password', token: String(req.body.token || ''), error: error.message,
        });
      }
      return next(error);
    }
  });

  const loginHandler = (req, res, next) => {
    try {
      const credentials = safeParse(loginSchema, req.body);
      const user = auth.authenticate(credentials.email, credentials.password);
      if (req.session) auth.destroySession(req.session.id);
      const session = auth.createSession(user.id);
      res.cookie('health_session', session.id, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        maxAge: config.sessionTtlSeconds * 1000,
        path: '/',
      });
      if (wantsJson(req)) return res.status(200).json({ user, csrfToken: session.csrfToken });
      return res.redirect('/dashboard');
    } catch (error) {
      if (!wantsJson(req) && error instanceof AppError) return res.status(error.statusCode).render('login', { title: 'Sign in', error: error.message, message: null });
      return next(error);
    }
  };

  router.post('/auth/login', loginHandler);
  router.post('/api/auth/login', loginHandler);

  router.post('/auth/logout', requireAuth, requireCsrf, (req, res) => {
    auth.destroySession(req.session.id);
    res.clearCookie('health_session', { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
    if (wantsJson(req)) return res.status(204).end();
    return res.redirect('/');
  });

  router.get('/dashboard', requireAuth, (req, res) => {
    const isAdmin = req.session.user.role === 'admin';
    const model = {
      title: 'Dashboard',
      appointments: appointments.listForActor(req.session.user),
      doctors: isAdmin ? appointments.listDoctors() : [],
      outbox: isAdmin ? appointments.listOutbox() : [],
      accounts: isAdmin ? accounts.listAccounts() : [],
      outboxMetrics: isAdmin ? appointments.getOutboxMetrics() : null,
      notificationActivity: isAdmin ? appointments.listRecentNotificationActivity() : [],
      message: req.query.message || null,
      errorMessage: req.query.error || null,
    };
    return renderOrJson(req, res, 'dashboard', model);
  });

  const createAccountHandler = (allowAdmin) => (req, res, next) => {
    try {
      const input = safeParse(allowAdmin ? adminAccountSchema : accountSchema, req.body);
      const created = accounts.createAccount(req.session.user, input, allowAdmin);
      if (wantsJson(req)) return res.status(201).json({ user: created });
      return res.redirect(`/dashboard?message=${encodeURIComponent(`${created.role} account created.`)}`);
    } catch (error) {
      if (!wantsJson(req) && error instanceof AppError) {
        return res.redirect(`/dashboard?error=${encodeURIComponent(error.message)}`);
      }
      return next(error);
    }
  };

  router.post('/admin/accounts', requireRole('admin'), requireCsrf, createAccountHandler(false));
  router.post('/admin/accounts/admin', requireRole('admin'), requireCsrf, createAccountHandler(true));

  router.post('/admin/accounts/:id/:action', requireRole('admin'), requireCsrf, (req, res, next) => {
    try {
      const action = req.params.action;
      if (!['disable', 'reactivate'].includes(action)) throw new ValidationError('Invalid account action');
      const status = action === 'disable' ? 'disabled' : 'active';
      const account = accounts.changeStatus(req.session.user, Number(req.params.id), status);
      if (wantsJson(req)) return res.status(200).json({ account });
      return res.redirect(`/dashboard?message=${encodeURIComponent(`Account ${status}.`)}`);
    } catch (error) {
      if (!wantsJson(req) && error instanceof AppError) {
        return res.redirect(`/dashboard?error=${encodeURIComponent(error.message)}`);
      }
      return next(error);
    }
  });

  router.post('/admin/notifications/:eventId/redrive', requireRole('admin'), requireCsrf, (req, res, next) => {
    try {
      const { reason } = safeParse(redriveSchema, req.body);
      const result = appointments.redriveDeadEvent(req.session.user, req.params.eventId, reason);
      if (wantsJson(req)) return res.status(202).json({ event: result });
      return res.redirect('/dashboard?message=Notification%20event%20queued%20for%20manual%20redrive.');
    } catch (error) {
      if (!wantsJson(req) && error instanceof AppError) {
        return res.redirect(`/dashboard?error=${encodeURIComponent(error.message)}`);
      }
      return next(error);
    }
  });

  router.get('/appointments/new', requireRole('patient'), (req, res) => res.render('appointment-new', {
    title: 'Book appointment',
    idempotencyKey: crypto.randomUUID(),
    error: null,
  }));

  const createAppointmentHandler = (req, res, next) => {
    try {
      const idempotencyKey = req.get('idempotency-key') || req.body.idempotencyKey;
      const result = appointments.createAppointment(req.session.user, req.body, idempotencyKey);
      metrics.appointmentsCreated += result.replayed ? 0 : 1;
      if (wantsJson(req)) return res.status(result.replayed ? 200 : 201).json(result);
      return res.redirect(`/dashboard?message=${encodeURIComponent(result.replayed ? 'Retry accepted: the original appointment was returned.' : 'Appointment requested successfully.')}`);
    } catch (error) {
      if (!wantsJson(req) && error instanceof AppError) {
        return res.status(error.statusCode).render('appointment-new', {
          title: 'Book appointment',
          idempotencyKey: req.body.idempotencyKey || crypto.randomUUID(),
          error: error.message,
        });
      }
      return next(error);
    }
  };

  router.post('/appointments', requireRole('patient'), requireCsrf, createAppointmentHandler);
  router.post('/api/appointments', requireRole('patient'), requireCsrf, createAppointmentHandler);

  router.get('/api/appointments', requireAuth, (req, res) => res.json({ appointments: appointments.listForActor(req.session.user) }));
  router.get('/api/doctors', requireAuth, (req, res) => res.json({ doctors: appointments.listDoctors() }));

  const scheduleHandler = (req, res, next) => {
    try {
      const input = safeParse(scheduleSchema, req.body);
      const appointment = appointments.scheduleAppointment(req.session.user, req.params.id, input.doctorId, input.scheduledFor);
      if (wantsJson(req)) return res.status(200).json({ appointment });
      return res.redirect('/dashboard?message=Appointment%20scheduled.');
    } catch (error) {
      return next(error);
    }
  };

  router.post('/admin/appointments/:id/schedule', requireRole('admin'), requireCsrf, scheduleHandler);
  router.post('/api/admin/appointments/:id/schedule', requireRole('admin'), requireCsrf, scheduleHandler);

  const cancelHandler = (req, res, next) => {
    try {
      const appointment = appointments.transitionAppointment(req.session.user, req.params.id, 'cancelled');
      if (wantsJson(req)) return res.status(200).json({ appointment });
      return res.redirect('/dashboard?message=Appointment%20cancelled.');
    } catch (error) {
      return next(error);
    }
  };

  router.post('/appointments/:id/cancel', requireAuth, requireCsrf, cancelHandler);
  router.post('/api/appointments/:id/cancel', requireAuth, requireCsrf, cancelHandler);

  const completeHandler = (req, res, next) => {
    try {
      const prescription = safeParse(completionSchema, req.body);
      const appointment = appointments.completeAppointment(req.session.user, req.params.id, prescription);
      if (wantsJson(req)) return res.status(200).json({ appointment });
      return res.redirect('/dashboard?message=Appointment%20completed.');
    } catch (error) {
      return next(error);
    }
  };

  router.post('/doctor/appointments/:id/complete', requireRole('doctor'), requireCsrf, completeHandler);
  router.post('/api/doctor/appointments/:id/complete', requireRole('doctor'), requireCsrf, completeHandler);

  return router;
}

module.exports = { createRouter, wantsJson };
