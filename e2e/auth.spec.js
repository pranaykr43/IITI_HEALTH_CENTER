const { test, expect } = require('@playwright/test');
const { signIn } = require('./helpers');

test('home links to login, patient can sign in, protected route and logout work', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Care coordination, made clear.' })).toBeVisible();
  await page.getByRole('link', { name: 'Patient Sign In' }).first().click();
  await expect(page).toHaveURL(/\/login\/patient$/);
  await expect(page.getByRole('heading', { name: 'Patient Sign In' })).toBeVisible();

  await signIn(page, 'patient');
  await expect(page.getByRole('heading', { name: 'Your appointments' })).toBeVisible();
  await page.goto('/appointments/new');
  await expect(page.getByRole('heading', { name: 'Request an appointment' })).toBeVisible();

  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/');
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});

test('login rejects invalid credentials with an accessible error', async ({ page }) => {
  await page.goto('/login/patient');
  await page.getByLabel('Email address').fill('patient@health.local');
  await page.getByLabel('Password', { exact: true }).fill('incorrect test password');
  await page.getByRole('button', { name: 'Sign in as Patient' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
});

test('patient can create an account and enters the patient dashboard', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Browser Test Patient');
  await page.getByLabel('Email address').fill(`browser-patient-${Date.now()}@example.test`);
  await page.getByLabel(/Create a password/).fill('Browser-test-strong-password-2026!');
  await page.getByLabel('Confirm password').fill('Browser-test-strong-password-2026!');
  await page.getByRole('button', { name: 'Create patient account' }).click();
  await expect(page).toHaveURL(/\/dashboard\?message=/);
  await expect(page.getByRole('heading', { name: 'Your appointments' })).toBeVisible();
});
