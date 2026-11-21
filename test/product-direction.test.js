const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const views = path.join(__dirname, '..', 'src', 'views');
const render = (view, locals) => ejs.renderFile(path.join(views, `${view}.ejs`), locals);

test('homepage presents Health Centre services and clear patient and staff access', async () => {
  const html = await render('home', { title: 'Health Centre', currentUser: null });
  assert.match(html, /<title>Health Centre<\/title>/);
  assert.match(html, /href="\/login\/patient"[^>]*>Patient sign in/);
  assert.match(html, /href="\/register"[^>]*>Create a patient account/);
  assert.match(html, /href="\/login"[^>]*>Staff sign in/);
  assert.match(html, /not affiliated with or endorsed by IIT Indore/i);
  assert.doesNotMatch(html, /local demo|engineering showcase|try demo|explore demo/i);
});

test('patient OAuth is visible only on patient login and patient registration', async () => {
  const patient = await render('login', {
    title: 'Patient sign in', role: 'patient', roleInfo: { label: 'Patient' },
    googleEnabled: true, csrfToken: 'preview', error: null, message: null,
  });
  const doctor = await render('login', {
    title: 'Doctor sign in', role: 'doctor', roleInfo: { label: 'Doctor' },
    googleEnabled: true, csrfToken: 'preview', error: null, message: null,
  });
  const registration = await render('register', {
    title: 'Create account', googleEnabled: true, csrfToken: 'preview', error: null,
  });
  assert.match(patient, /href="\/auth\/google"[\s\S]*Continue with Google/);
  assert.match(patient, /Forgot password\?/);
  assert.doesNotMatch(doctor, /href="\/auth\/google"/);
  assert.match(doctor, /href="\/password\/forgot"/);
  assert.match(registration, /href="\/auth\/google"[\s\S]*Continue with Google/);
  assert.doesNotMatch(registration, /staff registration|doctor registration|administrator registration/i);
});

test('password recovery pages describe disabled email honestly and expose reset fields', async () => {
  const recovery = await render('password-forgot', {
    title: 'Forgot password', sent: true, emailEnabled: false, error: null,
  });
  const reset = await render('password-reset', {
    title: 'Reset password', token: 'single-use-preview', error: null,
  });
  assert.match(recovery, /No email was sent/);
  assert.match(recovery, /same response is shown/i);
  assert.match(reset, /name="token" value="single-use-preview"/);
  assert.match(reset, /name="password"/);
  assert.match(reset, /name="confirmPassword"/);
});
