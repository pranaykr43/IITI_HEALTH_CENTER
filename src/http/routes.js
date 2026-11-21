const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const QRCode = require('qrcode');
const { sessionDigest } = require('../services/auth-service');
const {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
} = require('../errors');

const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
  otp: z.string().trim().max(12).optional(),
  recoveryCode: z.string().trim().max(40).optional(),
});
const mfaChallengeSchema = z.object({
  code: z.string().trim().max(12).optional().default(''),
  recoveryCode: z.string().trim().max(40).optional().default(''),
}).refine((input) => input.code || input.recoveryCode, { message: 'Enter the code from your authenticator app or a recovery code' });
const mfaCodeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app') });

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

const FLASH_COOKIE = 'health_flash';
const MFA_PENDING_COOKIE = 'health_mfa_pending';
// Paths a staff member may use before enrolling in two-factor authentication.
const MFA_ENROLLMENT_PATHS = new Set(['/', '/account/security', '/account/mfa/enable', '/auth/logout']);
const FLASH_MAX_LENGTH = 500;

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

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function emailKey(req) {
  return String(req.body?.email || '').trim().toLowerCase().slice(0, 320);
}

function createRouter({ auth, appointments, accounts, passwordResets, googleOAuth, mfa, insights, audit, metrics, config, options = {} }) {
  const router = express.Router();
  const limiterDefaults = { standardHeaders: 'draft-7', legacyHeaders: false };
  const passwordResetRequestLimiter = rateLimit({
    ...limiterDefaults,
    windowMs: 15 * 60_000,
    limit: options.passwordResetRequestLimit ?? 5,
    message: { error: 'rate_limited', message: 'Please wait before requesting another password reset.' },
  });
  const passwordResetCompletionLimiter = rateLimit({
    ...limiterDefaults,
    windowMs: 15 * 60_000,
    limit: options.passwordResetCompletionLimit ?? 10,
    message: { error: 'rate_limited', message: 'Please wait before trying another password reset.' },
  });
  const registrationLimiter = rateLimit({
    ...limiterDefaults,
    windowMs: 60 * 60_000,
    limit: options.registrationLimit ?? 5,
    message: { error: 'rate_limited', message: 'Please wait before creating another account.' },
  });
  // Failed sign-ins are throttled per client and email, and separately per email across
  // all clients, so neither a single client nor a distributed guesser can brute force an
  // account. Successful sign-ins do not count against either budget.
  const loginRateLimitError = () => new AppError('Too many failed sign-in attempts. Wait 15 minutes and try again, or reset your password.', 429, 'rate_limited');
  const loginClientLimiter = rateLimit({
    ...limiterDefaults,
    windowMs: 15 * 60_000,
    limit: options.loginAttemptLimit ?? 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${req.ip}|${emailKey(req)}`,
    handler: (req, res, next) => next(loginRateLimitError()),
  });
  const loginAccountLimiter = rateLimit({
    ...limiterDefaults,
    windowMs: 15 * 60_000,
    limit: options.loginAccountAttemptLimit ?? 30,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `account|${emailKey(req)}`,
    handler: (req, res, next) => next(loginRateLimitError()),
  });

  const mfaChallengeLimiter = rateLimit({
    ...limiterDefaults,
    windowMs: 15 * 60_000,
    limit: options.mfaChallengeLimit ?? 20,
    skipSuccessfulRequests: true,
    handler: (req, res, next) => next(new AppError('Too many two-factor attempts. Wait 15 minutes and sign in again.', 429, 'rate_limited')),
  });
  const mfaManagementLimiter = rateLimit({
    ...limiterDefaults,
    windowMs: 15 * 60_000,
    limit: options.mfaManagementLimit ?? 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `mfa-manage|${req.session?.user?.id ?? req.ip}`,
    handler: (req, res, next) => next(new AppError('Too many incorrect codes. Wait 15 minutes and try again.', 429, 'rate_limited')),
  });

  const setFlash = (res, kind, text) => {
    const value = Buffer.from(JSON.stringify({ kind, text: String(text).slice(0, FLASH_MAX_LENGTH) })).toString('base64url');
    res.cookie(FLASH_COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 60_000, path: '/' });
  };
  // Status messages travel in a short-lived HttpOnly cookie set by this server instead of the
  // query string, so a crafted link cannot make the site display attacker-written text.
  const redirectWithFlash = (res, location, kind, text) => {
    setFlash(res, kind, text);
    return res.redirect(location);
  };

  const requireAuth = (req, res, next) => {
    if (!req.session) {
      if (wantsJson(req)) return next(new AuthenticationError());
      return res.redirect('/login');
    }
    return next();
  };

  const requireRole = (...roles) => (req, res, next) => {
    if (!req.session) {
      if (req.method === 'GET' && !wantsJson(req)) return res.redirect('/login');
      return next(new AuthenticationError());
    }
    if (!roles.includes(req.session.user.role)) return next(new AuthorizationError());
    return next();
  };

  const requireCsrf = (req, res, next) => {
    if (!req.session) return next(new AuthenticationError());
    const token = req.get('x-csrf-token') || req.body?._csrf;
    if (!safeEqual(token, req.session.csrfToken)) return next(new AuthorizationError('Invalid CSRF token'));
    return next();
  };

  const renderOrJson = (req, res, view, model, statusCode = 200) => {
    if (wantsJson(req)) return res.status(statusCode).json(model);
    return res.status(statusCode).render(view, model);
  };

  // Browser form posts that fail a business rule return to the dashboard with the reason
  // instead of a bare error page; API clients keep structured JSON errors.
  // Authentication and authorization failures keep their 401/403 status in every case.
  const dashboardErrorOr = (req, res, next, error, location = '/dashboard') => {
    if (!wantsJson(req) && error instanceof AppError && ![401, 403].includes(error.statusCode)) {
      return redirectWithFlash(res, location, 'error', error.message);
    }
    return next(error);
  };

  router.use((req, res, next) => {
    res.locals.currentUser = req.session ? req.session.user : null;
    res.locals.csrfToken = req.session ? req.session.csrfToken : '';
    res.locals.requestId = req.id;
    res.locals.flash = { message: null, error: null };
    const raw = req.cookies?.[FLASH_COOKIE];
    if (raw) {
      res.clearCookie(FLASH_COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
      try {
        const parsed = JSON.parse(Buffer.from(String(raw).slice(0, 2048), 'base64url').toString('utf8'));
        if (typeof parsed?.text === 'string') {
          const text = parsed.text.slice(0, FLASH_MAX_LENGTH);
          if (parsed.kind === 'error') res.locals.flash.error = text;
          else res.locals.flash.message = text;
        }
      } catch {
        // A malformed flash cookie is ignored.
      }
    }
    next();
  });

  // Doctors and administrators must enrol in two-factor authentication before doing
  // anything else when STAFF_MFA_REQUIRED is on (the production default).
  router.use((req, res, next) => {
    if (!req.session || req.session.user.mfaEnabled || !mfa.isRequiredFor(req.session.user)) return next();
    if (MFA_ENROLLMENT_PATHS.has(req.path)) return next();
    if (req.method === 'GET' && !wantsJson(req)) {
      return redirectWithFlash(res, '/account/security', 'error', 'Set up two-factor authentication to continue. It is required for doctor and administrator accounts.');
    }
    return next(new AppError('Two-factor authentication must be set up before this account can be used', 403, 'mfa_enrollment_required'));
  });

  router.get('/', (req, res) => res.render('home', { title: 'Health Centre' }));

  router.get('/login', (req, res) => {
    if (req.session) return res.redirect('/dashboard');
    return res.render('login-select', { title: 'Choose your sign-in', error: res.locals.flash.error, message: res.locals.flash.message });
  });

  const roleDetails = {
    patient: { label: 'Patient', description: 'Book appointments, follow appointment status, and access prescriptions.' },
    doctor: { label: 'Doctor', description: 'View assigned appointments, manage consultations, and record prescriptions.' },
    admin: { label: 'Administrator', description: 'Schedule care, manage accounts, and oversee centre operations.' },
  };
  const authCsrfCookie = 'health_auth_csrf';
  const setAuthFormToken = (res) => {
    const token = crypto.randomBytes(24).toString('hex');
    res.cookie(authCsrfCookie, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 15 * 60_000, path: '/' });
    return token;
  };
  const validAnonymousCsrf = (req) => safeEqual(req.cookies[authCsrfCookie], req.body?._csrf);
  const sessionCookieOptions = () => ({
    httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: config.sessionTtlSeconds * 1000, path: '/',
  });
  const mfaPendingCookieOptions = (maxAge) => ({ httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge, path: '/auth/mfa' });
  const clearMfaPending = (res) => res.clearCookie(MFA_PENDING_COOKIE, mfaPendingCookieOptions(undefined));
  // Password (or Google) verified for an account with two-factor enabled: issue a short-lived
  // pending sign-in instead of a session and ask for the second factor.
  const beginMfaChallenge = (req, res, userId) => {
    if (req.session) auth.destroySession(req.session.id);
    const pending = mfa.createPendingLogin(userId);
    res.cookie(MFA_PENDING_COOKIE, pending.token, mfaPendingCookieOptions(pending.expiresInMs));
    res.clearCookie(authCsrfCookie, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
    return res.redirect('/auth/mfa');
  };
  const startSession = (req, res, userId) => {
    if (req.session) auth.destroySession(req.session.id);
    const session = auth.createSession(userId);
    res.cookie('health_session', session.id, sessionCookieOptions());
    res.clearCookie(authCsrfCookie, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
    return session;
  };
  const renderLogin = (res, role, { error = null, message = null, statusCode = 200 } = {}) => res.status(statusCode).render('login', {
    title: `${roleDetails[role].label} sign in`, role, roleInfo: roleDetails[role],
    error, message, googleEnabled: role === 'patient' && googleOAuth.enabled,
    csrfToken: setAuthFormToken(res),
  });

  router.get('/login/:role', (req, res) => {
    const role = req.params.role;
    if (!Object.hasOwn(roleDetails, role)) return res.status(404).render('error', { title: 'Not found', error: { message: 'Sign-in route not found' } });
    if (req.session) return res.redirect('/dashboard');
    return renderLogin(res, role, { error: res.locals.flash.error, message: res.locals.flash.message });
  });

  const registrationSchema = z.object({
    email: z.string().trim().email().max(320),
    name: z.string().trim().min(1).max(120),
    password: z.string().min(12).max(200),
    confirmPassword: z.string().min(12).max(200),
  }).refine((input) => input.password === input.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });
  router.get('/register', (req, res) => {
    if (req.session) return res.redirect('/dashboard');
    return res.render('register', {
      title: 'Create a patient account', error: null, googleEnabled: googleOAuth.enabled,
      csrfToken: setAuthFormToken(res),
    });
  });
  router.post('/auth/register/patient', registrationLimiter, (req, res, next) => {
    try {
      if (!validAnonymousCsrf(req)) throw new AuthorizationError('Your form expired. Refresh the page and try again.');
      const input = safeParse(registrationSchema, req.body);
      const patient = accounts.registerPatient(input);
      const session = auth.createSession(patient.id);
      res.cookie('health_session', session.id, sessionCookieOptions());
      res.clearCookie(authCsrfCookie, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
      if (wantsJson(req)) return res.status(201).json({ user: patient, csrfToken: session.csrfToken });
      return redirectWithFlash(res, '/dashboard', 'message', 'Your patient account is ready.');
    } catch (error) {
      if (!wantsJson(req) && error instanceof AppError) return res.status(error.statusCode).render('register', {
        title: 'Create a patient account', error: error.message, googleEnabled: googleOAuth.enabled,
        csrfToken: setAuthFormToken(res),
      });
      return next(error);
    }
  });

  router.get('/auth/google', (req, res, next) => {
    try {
      if (!googleOAuth.enabled) return res.redirect('/login/patient');
      const browserToken = crypto.randomBytes(32).toString('base64url');
      const authorization = googleOAuth.createAuthorizationRequest(browserToken);
      res.cookie('health_google_browser', browserToken, {
        httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 10 * 60_000, path: '/auth/google',
      });
      return res.redirect(authorization.url);
    } catch (error) { return next(error); }
  });
  router.get('/auth/google/callback', async (req, res) => {
    try {
      if (req.query.error) throw new AuthenticationError('Google sign-in was cancelled or denied');
      const identity = await googleOAuth.authenticateCallback({
        state: String(req.query.state || ''), code: String(req.query.code || ''),
        browserToken: req.cookies.health_google_browser || '',
      });
      const patient = accounts.authenticateGooglePatient(identity);
      res.clearCookie('health_google_browser', { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/auth/google' });
      if (mfa.isEnabled(patient.id)) return beginMfaChallenge(req, res, patient.id);
      if (req.session) auth.destroySession(req.session.id);
      const session = auth.createSession(patient.id);
      res.clearCookie('health_google_browser', { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/auth/google' });
      res.cookie('health_session', session.id, sessionCookieOptions());
      return redirectWithFlash(res, '/dashboard', 'message', 'Signed in securely with Google.');
    } catch (error) {
      return redirectWithFlash(res, '/login/patient', 'error', error instanceof AppError ? error.message : 'Google sign-in could not be completed. Try again or use your password.');
    }
  });

  router.get('/password/forgot', (req, res) => res.render('password-forgot', {
    title: 'Reset password', sent: false, error: null, emailEnabled: config.emailEnabled,
  }));
  router.post('/password/forgot', passwordResetRequestLimiter, async (req, res, next) => {
    try {
      const { email } = safeParse(resetRequestSchema, req.body);
      const baseUrl = config.publicBaseUrl || `http://127.0.0.1:${config.port}`;
      await passwordResets.requestReset(email, baseUrl);
      return res.status(200).render('password-forgot', { title: 'Reset password', sent: true, error: null, emailEnabled: config.emailEnabled });
    } catch (error) {
      if (!wantsJson(req) && error instanceof AppError) {
        return res.status(error.statusCode).render('password-forgot', { title: 'Reset password', sent: false, error: error.message, emailEnabled: config.emailEnabled });
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
      return redirectWithFlash(res, '/login', 'message', 'Password changed. Sign in again.');
    } catch (error) {
      if (!wantsJson(req) && error instanceof AppError) {
        return res.status(error.statusCode).render('password-reset', {
          title: 'Choose a new password', token: String(req.body.token || ''), error: error.message,
        });
      }
      return next(error);
    }
  });

  const loginHandler = (expectedRole = null) => async (req, res, next) => {
    try {
      const browserForm = req.is('application/x-www-form-urlencoded');
      if ((expectedRole || browserForm) && !validAnonymousCsrf(req)) throw new AuthorizationError('Your form expired. Refresh the page and try again.');
      const credentials = safeParse(loginSchema, req.body);
      const user = await auth.authenticate(credentials.email, credentials.password);
      if (expectedRole && user.role !== expectedRole) {
        throw new AuthenticationError(`This account is not a ${roleDetails[expectedRole].label.toLowerCase()} account. Choose the correct sign-in option.`);
      }
      if (mfa.isEnabled(user.id)) {
        if (!wantsJson(req)) return beginMfaChallenge(req, res, user.id);
        if (!credentials.otp && !credentials.recoveryCode) {
          throw new AppError('A two-factor code is required for this account', 401, 'mfa_required');
        }
        if (!mfa.verifySecondFactor(user.id, { code: credentials.otp, recoveryCode: credentials.recoveryCode })) {
          throw new AuthenticationError('Invalid two-factor code');
        }
      }
      const session = startSession(req, res, user.id);
      if (wantsJson(req)) return res.status(200).json({ user, csrfToken: session.csrfToken });
      return res.redirect('/dashboard');
    } catch (error) {
      return next(error);
    }
  };
  const loginErrorPage = (expectedRole) => (error, req, res, next) => {
    if (!wantsJson(req) && error instanceof AppError && expectedRole) {
      return renderLogin(res, expectedRole, { error: error.message, statusCode: error.statusCode });
    }
    return next(error);
  };
  const validateLoginRole = (req, res, next) => {
    if (!Object.hasOwn(roleDetails, req.params.role)) return next(new ValidationError('Choose a valid sign-in role'));
    return next();
  };

  router.post('/auth/login', loginClientLimiter, loginAccountLimiter, loginHandler());
  router.post('/auth/login/:role', validateLoginRole, loginClientLimiter, loginAccountLimiter,
    (req, res, next) => loginHandler(req.params.role)(req, res, next),
    (error, req, res, next) => loginErrorPage(Object.hasOwn(roleDetails, req.params.role) ? req.params.role : null)(error, req, res, next));
  router.post('/api/auth/login', loginClientLimiter, loginAccountLimiter, loginHandler());

  const renderMfaChallenge = (res, { error = null, statusCode = 200, attemptsRemaining } = {}) => res.status(statusCode).render('mfa-challenge', {
    title: 'Two-factor verification', error, attemptsRemaining, csrfToken: setAuthFormToken(res),
  });
  router.get('/auth/mfa', (req, res) => {
    const pending = mfa.getPendingLogin(req.cookies[MFA_PENDING_COOKIE]);
    if (!pending) {
      clearMfaPending(res);
      return redirectWithFlash(res, '/login', 'error', 'Your sign-in expired. Enter your email and password again.');
    }
    return renderMfaChallenge(res, { error: res.locals.flash.error, attemptsRemaining: pending.attemptsRemaining });
  });
  router.post('/auth/mfa', mfaChallengeLimiter, (req, res, next) => {
    const token = req.cookies[MFA_PENDING_COOKIE];
    try {
      if (!validAnonymousCsrf(req)) throw new AuthorizationError('Your form expired. Refresh the page and try again.');
      const input = safeParse(mfaChallengeSchema, req.body);
      const result = mfa.completePendingLogin(token, { code: input.code, recoveryCode: input.code ? '' : input.recoveryCode });
      clearMfaPending(res);
      startSession(req, res, result.userId);
      if (result.method === 'recovery') {
        return redirectWithFlash(res, '/dashboard', 'message', `Signed in with a recovery code. ${result.recoveryCodesRemaining} recovery code${result.recoveryCodesRemaining === 1 ? '' : 's'} left; create new ones from Account security if you are running low.`);
      }
      return res.redirect('/dashboard');
    } catch (error) {
      if (!(error instanceof AppError) || wantsJson(req)) return next(error);
      const pending = mfa.getPendingLogin(token);
      if (!pending) {
        clearMfaPending(res);
        return redirectWithFlash(res, '/login', 'error', error.message);
      }
      return renderMfaChallenge(res, { error: error.message, statusCode: error.statusCode, attemptsRemaining: pending.attemptsRemaining });
    }
  });
  router.use('/auth/mfa', (error, req, res, next) => {
    if (error instanceof AppError && error.statusCode === 429 && !wantsJson(req)) {
      clearMfaPending(res);
      return redirectWithFlash(res, '/login', 'error', error.message);
    }
    return next(error);
  });

  router.post('/auth/logout', requireAuth, requireCsrf, (req, res) => {
    auth.destroySession(req.session.id);
    res.clearCookie('health_session', { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
    if (wantsJson(req)) return res.status(204).end();
    return res.redirect('/');
  });

  router.get('/dashboard', requireAuth, (req, res) => {
    const user = req.session.user;
    const isAdmin = user.role === 'admin';
    const flash = { message: res.locals.flash.message, errorMessage: res.locals.flash.error };
    if (!wantsJson(req)) {
      if (user.role === 'patient') {
        const all = appointments.listForActor(user);
        return res.render('dashboard-patient', {
          title: 'Your appointments', ...flash,
          active: all.filter((item) => ['requested', 'confirmed'].includes(item.status)),
          history: all.filter((item) => !['requested', 'confirmed'].includes(item.status)),
        });
      }
      if (user.role === 'doctor') {
        return res.render('dashboard-doctor', { title: 'Your schedule', ...flash, agenda: insights.doctorAgenda(user.doctorId) });
      }
      return res.render('dashboard-admin', {
        title: 'Scheduling desk', ...flash,
        overview: insights.adminOverview(),
        slotBoard: insights.slotBoard(),
        doctors: appointments.listDoctors(),
        outboxMetrics: appointments.getOutboxMetrics(),
      });
    }
    // JSON keeps its original shape for API clients.
    const model = {
      title: 'Dashboard',
      appointments: appointments.listForActor(req.session.user),
      doctors: isAdmin ? appointments.listDoctors() : [],
      outbox: isAdmin ? appointments.listOutbox() : [],
      accounts: isAdmin ? accounts.listAccounts() : [],
      outboxMetrics: isAdmin ? appointments.getOutboxMetrics() : null,
      notificationActivity: isAdmin ? appointments.listRecentNotificationActivity() : [],
      message: res.locals.flash.message,
      errorMessage: res.locals.flash.error,
    };
    return renderOrJson(req, res, 'dashboard', model);
  });

  router.get('/admin/accounts', requireRole('admin'), (req, res) => res.render('admin-accounts', {
    title: 'Accounts', accounts: accounts.listAccounts(),
    message: res.locals.flash.message, errorMessage: res.locals.flash.error,
  }));
  router.get('/admin/notifications', requireRole('admin'), (req, res) => res.render('admin-notifications', {
    title: 'Notifications',
    outbox: appointments.listOutbox(),
    outboxMetrics: appointments.getOutboxMetrics(),
    notificationActivity: appointments.listRecentNotificationActivity(),
    message: res.locals.flash.message, errorMessage: res.locals.flash.error,
  }));
  router.get('/admin/audit', requireRole('admin'), (req, res) => {
    const category = Object.hasOwn(audit.categories, String(req.query.category || '')) ? String(req.query.category) : '';
    const before = Number.parseInt(String(req.query.before || ''), 10);
    const page = audit.list({ category, beforeId: Number.isInteger(before) && before > 0 ? before : null });
    if (wantsJson(req)) return res.json(page);
    return res.render('admin-audit', { title: 'Audit log', categories: audit.categories, category, ...page });
  });

  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const renderRecoveryCodes = (req, res, recoveryCodes, heading) => {
    noStore(res);
    if (wantsJson(req)) return res.status(200).json({ recoveryCodes });
    return res.status(200).render('mfa-recovery-codes', { title: 'Save your recovery codes', heading, recoveryCodes });
  };
  const securityErrorOr = (req, res, next, error) => {
    if (!wantsJson(req) && error instanceof AppError && ![401, 403].includes(error.statusCode)) {
      return redirectWithFlash(res, '/account/security', 'error', error.message);
    }
    return next(error);
  };

  router.get('/account/security', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.user;
      const status = mfa.status(user.id);
      let setup = null;
      const demoLocked = mfa.isDemoLocked(user);
      if (!status.enabled && !demoLocked) {
        const pending = mfa.ensurePendingEnrollment(user);
        const qrSvg = await QRCode.toString(pending.otpauthUri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        setup = {
          secret: pending.secret,
          secretGroups: pending.secret.match(/.{1,4}/g).join(' '),
          otpauthUri: pending.otpauthUri,
          qrDataUri: `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString('base64')}`,
        };
      }
      noStore(res);
      const required = mfa.isRequiredFor(user);
      if (wantsJson(req)) return res.json({ status, required, setup: setup && { secret: setup.secret, otpauthUri: setup.otpauthUri } });
      return res.render('account-security', {
        title: 'Account security', status, setup, required, demoLocked,
        message: res.locals.flash.message, errorMessage: res.locals.flash.error,
      });
    } catch (error) {
      return next(error);
    }
  });
  router.post('/account/mfa/enable', requireAuth, requireCsrf, mfaManagementLimiter, (req, res, next) => {
    try {
      const { code } = safeParse(mfaCodeSchema, req.body);
      const { recoveryCodes } = mfa.confirmEnrollment(req.session.user, code, sessionDigest(req.session.id));
      return renderRecoveryCodes(req, res, recoveryCodes, 'Two-factor authentication is on');
    } catch (error) {
      return securityErrorOr(req, res, next, error);
    }
  });
  router.post('/account/mfa/recovery-codes', requireAuth, requireCsrf, mfaManagementLimiter, (req, res, next) => {
    try {
      const { code } = safeParse(mfaCodeSchema, req.body);
      const { recoveryCodes } = mfa.regenerateRecoveryCodes(req.session.user, code);
      return renderRecoveryCodes(req, res, recoveryCodes, 'New recovery codes created');
    } catch (error) {
      return securityErrorOr(req, res, next, error);
    }
  });
  router.post('/account/mfa/disable', requireAuth, requireCsrf, mfaManagementLimiter, (req, res, next) => {
    try {
      const { code } = safeParse(mfaCodeSchema, req.body);
      mfa.disable(req.session.user, code);
      if (wantsJson(req)) return res.status(204).end();
      return redirectWithFlash(res, '/account/security', 'message', 'Two-factor authentication is off.');
    } catch (error) {
      return securityErrorOr(req, res, next, error);
    }
  });
  router.post('/admin/accounts/:id/reset-mfa', requireRole('admin'), requireCsrf, (req, res, next) => {
    try {
      const result = mfa.adminReset(req.session.user, Number(req.params.id));
      if (wantsJson(req)) return res.status(200).json(result);
      return redirectWithFlash(res, '/admin/accounts', 'message', result.reset
        ? 'Two-factor authentication was reset and the account was signed out everywhere.'
        : 'That account had no two-factor authentication; its sessions were signed out.');
    } catch (error) {
      return dashboardErrorOr(req, res, next, error, '/admin/accounts');
    }
  });

  const createAccountHandler = (allowAdmin) => (req, res, next) => {
    try {
      const input = safeParse(allowAdmin ? adminAccountSchema : accountSchema, req.body);
      const created = accounts.createAccount(req.session.user, input, allowAdmin);
      if (wantsJson(req)) return res.status(201).json({ user: created });
      return redirectWithFlash(res, '/admin/accounts', 'message', `${{ patient: 'Patient', doctor: 'Doctor', admin: 'Administrator' }[created.role]} account created for ${created.email}.`);
    } catch (error) {
      return dashboardErrorOr(req, res, next, error, '/admin/accounts');
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
      return redirectWithFlash(res, '/admin/accounts', 'message', `Account ${status}.`);
    } catch (error) {
      return dashboardErrorOr(req, res, next, error, '/admin/accounts');
    }
  });

  router.post('/admin/notifications/:eventId/redrive', requireRole('admin'), requireCsrf, (req, res, next) => {
    try {
      const { reason } = safeParse(redriveSchema, req.body);
      const result = appointments.redriveDeadEvent(req.session.user, req.params.eventId, reason);
      if (wantsJson(req)) return res.status(202).json({ event: result });
      return redirectWithFlash(res, '/admin/notifications', 'message', 'Notification event queued for manual redrive.');
    } catch (error) {
      return dashboardErrorOr(req, res, next, error, '/admin/notifications');
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
      return redirectWithFlash(res, '/dashboard', 'message', result.replayed ? 'Retry accepted: the original appointment was returned.' : 'Appointment requested successfully.');
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
      return redirectWithFlash(res, '/dashboard', 'message', 'Appointment scheduled.');
    } catch (error) {
      return dashboardErrorOr(req, res, next, error);
    }
  };

  router.post('/admin/appointments/:id/schedule', requireRole('admin'), requireCsrf, scheduleHandler);
  router.post('/api/admin/appointments/:id/schedule', requireRole('admin'), requireCsrf, scheduleHandler);

  const cancelHandler = (req, res, next) => {
    try {
      const appointment = appointments.transitionAppointment(req.session.user, req.params.id, 'cancelled');
      if (wantsJson(req)) return res.status(200).json({ appointment });
      return redirectWithFlash(res, '/dashboard', 'message', 'Appointment cancelled.');
    } catch (error) {
      return dashboardErrorOr(req, res, next, error);
    }
  };

  router.post('/appointments/:id/cancel', requireAuth, requireCsrf, cancelHandler);
  router.post('/api/appointments/:id/cancel', requireAuth, requireCsrf, cancelHandler);

  const completeHandler = (req, res, next) => {
    try {
      const prescription = safeParse(completionSchema, req.body);
      const appointment = appointments.completeAppointment(req.session.user, req.params.id, prescription);
      if (wantsJson(req)) return res.status(200).json({ appointment });
      return redirectWithFlash(res, '/dashboard', 'message', 'Appointment completed.');
    } catch (error) {
      return dashboardErrorOr(req, res, next, error);
    }
  };

  router.post('/doctor/appointments/:id/complete', requireRole('doctor'), requireCsrf, completeHandler);
  router.post('/api/doctor/appointments/:id/complete', requireRole('doctor'), requireCsrf, completeHandler);

  return router;
}

module.exports = { createRouter, wantsJson, safeEqual };
