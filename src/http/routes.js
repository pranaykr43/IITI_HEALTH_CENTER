const crypto = require('node:crypto');
const express = require('express');
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

function createRouter({ auth, appointments, metrics, config }) {
  const router = express.Router();

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
    return res.render('login', { title: 'Sign in', error: null });
  });

  const loginHandler = (req, res, next) => {
    try {
      const credentials = safeParse(loginSchema, req.body);
      const user = auth.authenticate(credentials.email, credentials.password);
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
      if (!wantsJson(req) && error instanceof AppError) return res.status(error.statusCode).render('login', { title: 'Sign in', error: error.message });
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
    const model = {
      title: 'Dashboard',
      appointments: appointments.listForActor(req.session.user),
      doctors: req.session.user.role === 'admin' ? appointments.listDoctors() : [],
      outbox: req.session.user.role === 'admin' ? appointments.listOutbox() : [],
      message: req.query.message || null,
    };
    return renderOrJson(req, res, 'dashboard', model);
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
