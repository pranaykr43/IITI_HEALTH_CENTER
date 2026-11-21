#!/usr/bin/env node
// Captures README screenshots from a running local server seeded with
// `npm run seed:showcase`. Usage:
//   SHOWCASE_URL=http://127.0.0.1:3000 HEALTH_DEMO_PASSWORD=... node scripts/capture-screenshots.js
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');

const baseURL = process.env.SHOWCASE_URL || 'http://127.0.0.1:3000';
const password = process.env.HEALTH_DEMO_PASSWORD;
const outDir = path.join(__dirname, '..', 'docs', 'screenshots');

async function signIn(page, role, email) {
  await page.goto(`${baseURL}/login/${role}`);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /Sign in as/ }).click();
  await page.waitForURL('**/dashboard');
}

async function main() {
  if (!password) throw new Error('Set HEALTH_DEMO_PASSWORD to the password used by seed:showcase');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const shoot = async (name, { scheme = 'light', viewport = { width: 1360, height: 860 }, run }) => {
    const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await run(page);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    await context.close();
    console.log(`captured ${name}.png`);
  };

  await shoot('home', { run: (page) => page.goto(`${baseURL}/`) });
  await shoot('home-dark', { scheme: 'dark', run: (page) => page.goto(`${baseURL}/`) });
  await shoot('scheduling-desk', { viewport: { width: 1440, height: 1000 }, run: async (page) => {
    await signIn(page, 'admin', 'admin@health.local');
    const select = page.locator('[data-doctor-select]').first();
    await select.selectOption({ index: 2 });
    await page.evaluate(() => globalThis.scrollTo(0, 0));
  } });
  await shoot('patient-appointments', { run: (page) => signIn(page, 'patient', 'patient@health.local') });
  await shoot('patient-mobile', { viewport: { width: 390, height: 844 }, run: (page) => signIn(page, 'patient', 'patient@health.local') });
  await shoot('audit-log', { scheme: 'dark', run: async (page) => {
    await signIn(page, 'admin', 'admin@health.local');
    await page.goto(`${baseURL}/admin/audit`);
  } });
  await browser.close();
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
