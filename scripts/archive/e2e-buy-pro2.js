const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const EMAIL = 'e2e-pro-upgrade@test.local';
const PASS = 'Test123456';
const CARD = '4242424242424242';
const EXP = '12/35';
const CVC = '123';

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/exchange-apis', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  console.log('登录完成:', page.url());

  await page.goto(`${BASE}/subscriptions`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // 点 Pro
  await page.locator('button', { hasText: '选择月付 10 USD' }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('button[data-pcw-method="stripe"]').first().click();
  await page.waitForTimeout(800);

  // 带重试点「继续付款」（应对 SSL 抖动导致的 502）
  let jumped = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`[attempt ${attempt}] 点继续付款`);
    await page.locator('button[data-pcw="pay"]').first().click();
    try {
      await page.waitForURL(/checkout\.stripe\.com/, { timeout: 15000 });
      jumped = true;
      break;
    } catch (e) {
      console.log(`[attempt ${attempt}] 未跳转，可能 502/SSL，重试...`);
      await page.waitForTimeout(1500);
      continue;
    }
  }
  if (!jumped) { console.log('无法跳转到 Stripe'); await page.screenshot({ path: 'C:\\Users\\zyjy2\\AppData\\Local\\Temp\\e2e-nojump.png' }); await browser.close(); return; }

  console.log('=== 已跳到 Stripe ===', page.url());
  await page.waitForTimeout(6000);

  // Stripe Checkout 卡字段通常在 iframe（elements-inner）。遍历 iframe 找卡号输入。
  const frames = page.frames();
  console.log('iframe 数量:', frames.length, frames.map(f => f.url().slice(0,60)));

  // 用 frameLocator 填入卡号
  let filled = false;
  for (const f of frames) {
    if (!/stripe|elements/.test(f.url())) continue;
    try {
      const cardInput = f.locator('input[name="cardNumber"], input[name="number"], input[autocomplete="cc-number"], #cardNumber');
      if (await cardInput.count()) {
        console.log('找到卡号输入 in frame:', f.url().slice(0,60));
        await cardInput.first().fill(CARD);
        const expInput = f.locator('input[name="cardExpiry"], input[autocomplete="cc-exp"], #cardExpiry');
        if (await expInput.count()) await expInput.first().fill(EXP);
        const cvcInput = f.locator('input[name="cardCvc"], input[autocomplete="cc-csc"], #cardCvc');
        if (await cvcInput.count()) await cvcInput.first().fill(CVC);
        filled = true;
        break;
      }
    } catch (e) {}
  }
  console.log('填卡完成:', filled);
  await page.screenshot({ path: 'C:\\Users\\zyjy2\\AppData\\Local\\Temp\\e2e-stripe-filled.png', fullPage: true });

  // dump 顶层 + iframe 的所有 input，供后续调试
  const topInputs = await page.$$eval('input', els => els.map(e => ({name:e.name,id:e.id,placeholder:e.placeholder,autocomplete:e.autocomplete})));
  console.log('顶层 inputs:', JSON.stringify(topInputs));
  for (const f of frames) {
    try {
      const ins = await f.$$eval('input', els => els.map(e => ({name:e.name,id:e.id,placeholder:e.placeholder,autocomplete:e.autocomplete})));
      if (ins.length) console.log('frame input:', f.url().slice(0,50), JSON.stringify(ins));
    } catch(_){}
  }

  await page.waitForTimeout(3000);
  await browser.close();
  console.log('DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
