const { test, expect } = require('@playwright/test');
const { signIn } = require('./helpers');

test('admin provisions a patient who completes password recovery', async ({ page, browser, baseURL }) => {
  const email = `new-patient-${Date.now()}@health.local`;
  await signIn(page, 'admin');
  await page.locator('#account-name').fill('Synthetic New Patient');
  await page.locator('#account-email').fill(email);
  await page.locator('#account-password').fill('Temporary-Strong-Password-77!');
  await page.getByRole('button', { name: 'Create patient or doctor' }).click();
  await expect(page.getByRole('status')).toContainText('patient account created');

  const patientContext = await browser.newContext({ baseURL });
  const patientPage = await patientContext.newPage();
  await patientPage.goto('/password/forgot');
  await patientPage.getByLabel('Email').fill(email);
  await patientPage.getByRole('button', { name: 'Send reset link' }).click();
  await expect(patientPage.getByRole('status')).toContainText('If an active account matches');
  const response = await patientPage.request.get(`${baseURL}/__e2e/password-reset-link?email=${encodeURIComponent(email)}`);
  expect(response.status()).toBe(200);
  const { link } = await response.json();
  const token = new URL(link).searchParams.get('token');
  expect(token).toBeTruthy();

  await patientPage.goto(`/password/reset?token=${encodeURIComponent(token)}`);
  await patientPage.getByLabel('New password', { exact: true }).fill('Recovered-Strong-Password-88!');
  await patientPage.getByLabel('Confirm new password').fill('Recovered-Strong-Password-88!');
  await patientPage.getByRole('button', { name: 'Change password' }).click();
  await expect(patientPage).toHaveURL(/\/login\?message=/);
  await patientPage.getByLabel('Email').fill(email);
  await patientPage.getByLabel('Password').fill('Recovered-Strong-Password-88!');
  await patientPage.getByRole('button', { name: 'Sign in' }).click();
  await patientPage.waitForURL('**/dashboard');
  await expect(patientPage.getByRole('heading', { name: 'Your appointments' })).toBeVisible();

  await signIn(page, 'admin');
  const accountRow = page.locator('tr').filter({ hasText: email });
  await accountRow.getByRole('button', { name: 'Disable' }).click();
  await expect(page.locator('tr').filter({ hasText: email })).toContainText('disabled');
  await patientPage.goto('/dashboard');
  await expect(patientPage).toHaveURL(/\/login$/);
  await page.locator('tr').filter({ hasText: email }).getByRole('button', { name: 'Reactivate' }).click();
  await expect(page.locator('tr').filter({ hasText: email })).toContainText('active');
  await patientPage.goto('/login');
  await patientPage.getByLabel('Email').fill(email);
  await patientPage.getByLabel('Password').fill('Recovered-Strong-Password-88!');
  await patientPage.getByRole('button', { name: 'Sign in' }).click();
  await patientPage.waitForURL('**/dashboard');
  await patientContext.close();
});

test('admin redrive records a reason and preserves event attempts', async ({ page }) => {
  await page.request.post('/__e2e/reset-redrive-fixture');
  await signIn(page, 'admin');
  const row = page.locator('tr').filter({ hasText: 'e2e-redrive-event' });
  await expect(row).toContainText('dead');
  await expect(row).toContainText('5');
  await row.getByLabel('Reason for redriving this event').fill('Verified local adapter recovery procedure');
  await row.getByRole('button', { name: 'Redrive' }).click();
  await expect(page.getByRole('status')).toContainText('Notification event queued');
  const requeued = page.locator('tr').filter({ hasText: 'e2e-redrive-event' });
  await expect(requeued).toContainText('pending');
  await expect(requeued).toContainText('5');
});
