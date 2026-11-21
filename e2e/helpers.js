const PASSWORD = 'E2E-only-Strong-Password-2026!';

async function signIn(page, role) {
  const emails = {
    patient: 'patient@health.local',
    admin: 'admin@health.local',
    doctor: 'doctor@health.local',
    doctor2: 'doctor2@health.local',
  };
  await page.goto('/dashboard');
  if (page.url().endsWith('/dashboard')) {
    // Wait for the sign-out POST to finish; navigating immediately can cancel it in WebKit.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL((url) => url.pathname === '/');
  }
  const signInRole = role === 'admin' ? 'admin' : role.startsWith('doctor') ? 'doctor' : 'patient';
  const label = signInRole === 'admin' ? 'Administrator' : signInRole[0].toUpperCase() + signInRole.slice(1);
  await page.goto(`/login/${signInRole}`);
  await page.getByLabel('Email address').fill(emails[role]);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: `Sign in as ${label}` }).click();
  await page.waitForURL('**/dashboard');
}

async function requestAppointment(page, phoneSuffix = Date.now()) {
  await page.goto('/appointments/new');
  await page.getByLabel('Phone number').fill(`555${String(phoneSuffix).slice(-7)}`);
  await page.getByLabel('Age').fill('28');
  await page.getByLabel('Brief description', { exact: true }).fill('Persistent headache for evaluation');
  await page.getByLabel('Days with symptoms').fill('2');
  await page.getByRole('button', { name: 'Submit appointment request' }).click();
  await page.waitForURL('**/dashboard');
  await page.getByRole('status').filter({ hasText: 'Appointment requested successfully.' }).waitFor();
  return page.locator('tbody tr').first().locator('small').innerText();
}

// Returns a 10:30 wall-clock slot on a weekday, matching the seeded doctor's
// Monday-Friday 09:00-17:00 availability in clinic time.
function slotFromNow(days = 8) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  while ([0, 6].includes(date.getDay())) date.setDate(date.getDate() + 1);
  date.setHours(10, 30, 0, 0);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T10:30`;
}

module.exports = { PASSWORD, signIn, requestAppointment, slotFromNow };
