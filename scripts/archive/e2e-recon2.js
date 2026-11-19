const { chromium } = require('playwright');

const BASE = 'http://localhost:3000';
const EMAIL = 'e2e-pro-upgrade@test.local';
const PASS = 'Test123456';

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/exchange-apis', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // 进入订阅页
  await page.goto(`${BASE}/subscriptions`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  console.log('=== 订阅页 URL ===', page.url());
  console.log('=== 所有 button 文本 ===');
  const buttons = await page.$$eval('button', els => els.map(e => (e.innerText || '').trim()).filter(Boolean));
  console.log(JSON.stringify(buttons, null, 2));
  await page.screenshot({ path: '/tmp/e2e-03-subscriptions.png', fullPage: true });

  await browser.close();
  console.log('DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
