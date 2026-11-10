const { test, expect } = require('@playwright/test');
const { signIn, requestAppointment, slotFromNow } = require('./helpers');

test('patient request, admin scheduling conflict, and doctor completion', async ({ browser }, testInfo) => {
  const patient = await browser.newPage();
  await signIn(patient, 'patient');
  const firstId = await requestAppointment(patient, `${Date.now()}1`);
  const secondId = await requestAppointment(patient, `${Date.now()}2`);

  await signIn(patient, 'admin');
  const browserOffset = { chromium: 0, firefox: 10, webkit: 20 }[testInfo.project.name];
  const slot = slotFromNow(8 + browserOffset);
  const firstRow = patient.locator('tbody tr').filter({ hasText: firstId });
  await firstRow.locator('select[name="doctorId"]').selectOption({ index: 1 });
  await firstRow.locator('input[name="scheduledFor"]').fill(slot);
  await firstRow.getByRole('button', { name: 'Schedule' }).click();
  await expect(patient.getByRole('status')).toContainText('Appointment scheduled.');

  const secondRow = patient.locator('tbody tr').filter({ hasText: secondId });
  await secondRow.locator('select[name="doctorId"]').selectOption({ index: 1 });
  await secondRow.locator('input[name="scheduledFor"]').fill(slot);
  await secondRow.getByRole('button', { name: 'Schedule' }).click();
  await expect(patient.getByRole('heading', { name: 'That doctor is already booked for the requested time' })).toBeVisible();

  await signIn(patient, 'doctor');
  const assignedRow = patient.locator('tbody tr').filter({ hasText: firstId });
  await expect(assignedRow).toContainText('confirmed');
  await assignedRow.getByLabel('Test').fill('Routine examination');
  await assignedRow.getByLabel('Medicine').fill('Rest and fluids');
  await assignedRow.getByLabel('Advice').fill('Follow up if symptoms continue');
  await assignedRow.getByRole('button', { name: 'Complete' }).click();
  await expect(patient.getByRole('status')).toContainText('Appointment completed.');
  await expect(patient.locator('tbody tr').filter({ hasText: firstId })).toContainText('completed');
  await patient.close();
});

test('patient can cancel an appointment before scheduling', async ({ page }) => {
  await signIn(page, 'patient');
  const id = await requestAppointment(page);
  const row = page.locator('tbody tr').filter({ hasText: id });
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('status')).toContainText('Appointment cancelled.');
  await expect(page.locator('tbody tr').filter({ hasText: id })).toContainText('cancelled');
});

test('appointment form blocks missing fields and rejects an invalid booking', async ({ page }) => {
  await signIn(page, 'patient');
  await page.goto('/appointments/new');
  await page.getByRole('button', { name: 'Request appointment' }).click();
  await expect(page).toHaveURL(/\/appointments\/new$/);
  await expect(page.getByLabel('Phone number')).toBeFocused();
  await expect(page.getByLabel('Phone number')).toHaveAttribute('required', '');

  await page.getByLabel('Phone number').fill('123');
  await page.getByLabel('Age').fill('28');
  await page.getByLabel('Symptoms', { exact: true }).fill('Persistent headache');
  await page.getByLabel('Days with symptoms').fill('2');
  await page.getByRole('button', { name: 'Request appointment' }).click();
  await expect(page.getByRole('alert')).toContainText('A valid phone number is required');
});
