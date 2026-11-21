const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { totp } = require('../src/security/totp');

const PASSWORD = 'Browser-mfa-strong-password-2026!';

async function expectNoSeriousAxeViolations(page, label, { reloadAfter = false } = {}) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious'), `${label} axe findings`).toEqual([]);
  // Filling an input after an axe scan crashes the Firefox page under Playwright 1.65 on
  // Windows; a reload clears the injected axe state and keeps the page under test the same.
  if (reloadAfter) await page.reload();
}

async function signOut(page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/');
}

async function passwordStep(page, email) {
  await page.goto('/login/patient');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in as Patient' }).click();
  await expect(page).toHaveURL(/\/auth\/mfa$/);
}

test('patient enables two-factor authentication, then signs in with a code and with a recovery code', async ({ page }, testInfo) => {
  const email = `mfa-${testInfo.project.name}-${Date.now()}@example.test`;
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Two Factor Patient');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel(/Create a password/).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create patient account' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByRole('link', { name: /^Security/ }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-factor authentication' })).toBeVisible();
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  await expectNoSeriousAxeViolations(page, 'account security setup', { reloadAfter: true });
  const secret = await page.locator('[data-mfa-secret]').getAttribute('data-mfa-secret');

  await page.getByLabel('Authentication code').fill('000000');
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  await expect(page.getByRole('alert')).toContainText('That code is not valid');

  await page.getByLabel('Authentication code').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  const codes = await page.getByRole('list', { name: 'Recovery codes' }).locator('code').allInnerTexts();
  expect(codes).toHaveLength(10);
  await expectNoSeriousAxeViolations(page, 'recovery codes');
  await page.getByRole('link', { name: 'I have saved my codes' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await signOut(page);

  await passwordStep(page, email);
  await expectNoSeriousAxeViolations(page, 'two-factor challenge', { reloadAfter: true });
  // The enrolment code's time step is spent, so use the next step's code (accepted as drift).
  await page.getByLabel('Authentication code').fill(totp(secret, Date.now() + 30_000));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Your appointments' })).toBeVisible();
  await signOut(page);

  await passwordStep(page, email);
  await page.getByText('Use a recovery code instead').click();
  await page.getByLabel('Recovery code').fill(codes[0]);
  await page.getByRole('button', { name: 'Sign in with recovery code' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('status')).toContainText('Signed in with a recovery code. 9 recovery codes left');
});
