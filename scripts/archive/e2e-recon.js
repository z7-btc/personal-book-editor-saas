const { chromium } = require('playwright');

const BASE = 'http://localhost:3000';
const EMAIL = 'e2e-pro-upgrade@test.local';
const PASS = 'Test123456';

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 120 });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('console', m => console.log('[browser]', m.type(), m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));

  // 登录
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  console.log('=== 登录页 DOM ===', (await page.content()).slice(0, 2000));
  await page.screenshot({ path: '/tmp/e2e-01-login.png', fullPage: true });

  // 尝试填邮箱密码
  const emailSel = await page.$('input[type="email"]');
  const passSel = await page.$('input[type="password"]');
  console.log('email input found:', !!emailSel, 'password input found:', !!passSel);
  if (emailSel && passSel) {
    await emailSel.fill(EMAIL);
    await passSel.fill(PASS);
    // 找提交按钮
    const btn = await page.$('button[type="submit"]');
    console.log('submit button found:', !!btn, btn ? (await btn.innerText()) : '');
    if (btn) { await btn.click(); await page.waitForTimeout(4000); }
    console.log('=== 登录后 URL ===', page.url());
    await page.screenshot({ path: '/tmp/e2e-02-after-login.png', fullPage: true });
  }

  await browser.close();
  console.log('DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
