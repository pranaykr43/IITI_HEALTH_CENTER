const { test, expect } = require('@playwright/test');
const { signIn } = require('./helpers');

test('home links to login, patient can sign in, protected route and logout work', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /care workflows/i })).toBeVisible();
  await page.getByRole('link', { name: 'Open the demo' }).click();
  await expect(page).toHaveURL(/\/login$/);

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
  await page.goto('/login');
  await page.getByLabel('Email').fill('patient@health.local');
  await page.getByLabel('Password').fill('incorrect test password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
});
