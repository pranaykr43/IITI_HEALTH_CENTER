const { test, expect } = require('@playwright/test');
const { signIn, requestAppointment, slotFromNow, slip } = require('./helpers');

test('patient request, admin scheduling conflict, and doctor completion', async ({ browser }, testInfo) => {
  test.slow();
  const patient = await browser.newPage();
  await signIn(patient, 'patient');
  const firstId = await requestAppointment(patient, `${Date.now()}1`);
  const secondId = await requestAppointment(patient, `${Date.now()}2`);

  await signIn(patient, 'admin');
  const browserOffset = { chromium: 0, firefox: 10, webkit: 20 }[testInfo.project.name] + testInfo.retry * 7;
  const slot = slotFromNow(8 + browserOffset);
  const firstRow = slip(patient, firstId);
  await firstRow.locator('select[name="doctorId"]').selectOption({ index: 1 });
  await firstRow.locator('input[name="scheduledFor"]').fill(slot);
  await firstRow.getByRole('button', { name: 'Schedule' }).click();
  await expect(patient.getByRole('status')).toContainText('Appointment scheduled.');

  const secondRow = slip(patient, secondId);
  await secondRow.locator('select[name="doctorId"]').selectOption({ index: 1 });
  await secondRow.locator('input[name="scheduledFor"]').fill(slot);
  await secondRow.getByRole('button', { name: 'Schedule' }).click();
  await expect(patient.getByRole('alert')).toContainText('That doctor is already booked for the requested time');

  await signIn(patient, 'doctor');
  const assignedRow = slip(patient, firstId);
  await expect(assignedRow).toContainText('Scheduled');
  await assignedRow.getByText('Record this visit').click();
  await assignedRow.getByLabel('Test').fill('Routine examination');
  await assignedRow.getByLabel('Medicine').fill('Rest and fluids');
  await assignedRow.getByLabel('Advice').fill('Follow up if symptoms continue');
  await assignedRow.getByRole('button', { name: 'Complete visit' }).click();
  await expect(patient.getByRole('status')).toContainText('Appointment completed.');
  await expect(slip(patient, firstId)).toContainText('Visit recorded');
  await patient.close();
});

test('patient can cancel an appointment before scheduling', async ({ page }) => {
  await signIn(page, 'patient');
  const id = await requestAppointment(page);
  const row = slip(page, id);
  await expect(row).toContainText('Waiting for scheduling');
  await row.getByRole('button', { name: 'Cancel appointment' }).click();
  await expect(page.getByRole('status')).toContainText('Appointment cancelled.');
  await expect(slip(page, id)).toContainText('Cancelled');
});

test('appointment form blocks missing fields and rejects an invalid booking', async ({ page }) => {
  await signIn(page, 'patient');
  await page.goto('/appointments/new');
  await page.getByRole('button', { name: 'Submit appointment request' }).click();
  await expect(page).toHaveURL(/\/appointments\/new$/);
  await expect(page.getByLabel('Phone number')).toBeFocused();
  await expect(page.getByLabel('Phone number')).toHaveAttribute('required', '');

  await page.getByLabel('Phone number').fill('123');
  await page.getByLabel('Age').fill('28');
  await page.getByLabel('Brief description', { exact: true }).fill('Persistent headache');
  await page.getByLabel('Days with symptoms').fill('2');
  await page.getByRole('button', { name: 'Submit appointment request' }).click();
  await expect(page.getByRole('alert')).toContainText('A valid phone number is required');
});
