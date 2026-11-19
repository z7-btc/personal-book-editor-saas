const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const EMAIL = 'e2e-pro-upgrade@test.local';
const PASS = 'Test123456';
const CARD = '4242424242424242';

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/exchange-apis', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);

  await page.goto(`${BASE}/subscriptions`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await page.locator('button', { hasText: '选择月付 10 USD' }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('button[data-pcw-method="stripe"]').first().click();
  await page.waitForTimeout(800);
  await page.locator('button[data-pcw="pay"]').first().click();

  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(8000);
  console.log('=== Stripe URL ===', page.url());

  // 等 Stripe 完全渲染，找 iframe
  const frames = page.frames();
  console.log('=== iframe 数量 ===', frames.length);
  for (const f of frames) {
    console.log('iframe url:', f.url().slice(0, 100));
  }

  // 找所有 input / iframe 里的字段
  const inputs = await page.$$eval('iframe', els => els.map((e,i) => ({i, name: e.name, src: (e.src||'').slice(0,80)})));
  console.log('=== 页面 iframe ===', JSON.stringify(inputs, null, 2));

  // 尝试在各种 iframe 里找 input
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    try {
      const fields = await f.$$eval('input', els => els.map(e => ({ name: e.name, id: e.id, autocomplete: e.autocomplete, placeholder: e.placeholder, type: e.type })).filter(x => x.name || x.id));
      if (fields.length) console.log(`iframe[${i}] inputs:`, JSON.stringify(fields, null, 2));
    } catch (_) {}
  }

  // 顶层 input
  const topInputs = await page.$$eval('input', els => els.map(e => ({ name: e.name, id: e.id, autocomplete: e.autocomplete, placeholder: e.placeholder, type: e.type })).filter(x => x.name || x.id));
  console.log('=== 顶层 inputs ===', JSON.stringify(topInputs, null, 2));

  await page.screenshot({ path: 'C:\\Users\\zyjy2\\AppData\\Local\\Temp\\e2e-stripe-full.png', fullPage: true });
  await browser.close();
  console.log('DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
