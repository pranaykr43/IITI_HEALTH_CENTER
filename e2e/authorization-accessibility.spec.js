const { test, expect, request } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { signIn, requestAppointment } = require('./helpers');

test('authenticated patient cannot perform admin or doctor actions; CSRF is enforced', async ({ page, baseURL }) => {
  await signIn(page, 'patient');
  const appointmentId = await requestAppointment(page);
  const csrfToken = await page.locator('input[name="_csrf"]').first().getAttribute('value');

  const adminAttempt = await page.request.post(`/admin/appointments/${appointmentId}/schedule`, {
    form: { doctorId: '1', scheduledFor: '2030-01-01T10:30', _csrf: csrfToken },
  });
  expect(adminAttempt.status()).toBe(403);
  const doctorAttempt = await page.request.post(`/doctor/appointments/${appointmentId}/complete`, {
    form: { _csrf: csrfToken },
  });
  expect(doctorAttempt.status()).toBe(403);

  const missingCsrf = await page.request.post(`/appointments/${appointmentId}/cancel`);
  expect(missingCsrf.status()).toBe(403);
  const anonymous = await request.newContext({ baseURL });
  const unauthenticated = await anonymous.get('/dashboard', { maxRedirects: 0 });
  expect(unauthenticated.status()).toBe(302);
  await anonymous.dispose();
});

test('doctor sees only assigned appointments and cannot complete another doctor’s booking', async ({ browser }) => {
  const patient = await browser.newPage();
  await signIn(patient, 'patient');
  const appointmentId = await requestAppointment(patient);
  await signIn(patient, 'admin');
  const row = patient.locator('tbody tr').filter({ hasText: appointmentId });
  await row.locator('select[name="doctorId"]').selectOption({ index: 1 });
  await row.locator('input[name="scheduledFor"]').fill('2030-01-02T10:30');
  await row.getByRole('button', { name: 'Schedule' }).click();

  await signIn(patient, 'doctor2');
  await expect(patient.locator('tbody tr').filter({ hasText: appointmentId })).toHaveCount(0);
  const response = await patient.request.post(`/doctor/appointments/${appointmentId}/complete`, {
    form: { test: '', medicine: '', advice: '' },
  });
  expect(response.status()).toBe(403);
  await patient.close();
});

test('home, login, patient, admin, and doctor pages have no serious axe violations', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pages = [
    { url: '/', role: null },
    { url: '/login', role: null },
    { url: '/password/forgot', role: null },
    { url: '/password/reset', role: null },
    { url: '/dashboard', role: 'patient' },
    { url: '/dashboard', role: 'admin' },
    { url: '/dashboard', role: 'doctor' },
    { url: '/appointments/new', role: 'patient' },
  ];
  for (const entry of pages) {
    if (entry.role) await signIn(page, entry.role);
    await page.goto(entry.url);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(result.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious'),
      `${entry.role || 'public'} ${entry.url} axe findings`).toEqual([]);
    if (entry.role) {
      await page.goto('/dashboard');
      await page.getByRole('button', { name: 'Sign out' }).click();
    }
  }
  await context.close();
});

test('desktop, tablet, and mobile layouts fit and support keyboard access', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/login');
    const dimensions = await page.evaluate(() => ({
      width: globalThis.document.documentElement.clientWidth,
      scrollWidth: globalThis.document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
    await page.getByLabel('Email').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveCount(1);
    await expect(page.locator(':focus')).toHaveAccessibleName(/password/i);
  }
});
