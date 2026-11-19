const { chromium } = require('playwright');

const BASE = 'http://localhost:3000';
const EMAIL = 'e2e-pro-upgrade@test.local';
const PASS = 'Test123456';

// Stripe 测试卡 4242 4242 4242 4242
const CARD = '4242424242424242';

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('[browser-error]', m.text()); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  page.on('request', req => {
    const u = req.url();
    if (/stripe|payment-center|subscriptions\/pay/.test(u)) console.log('[req]', req.method(), u.slice(0, 120));
  });

  // 1. 登录
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/exchange-apis', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  console.log('=== 登录完成 ===', page.url());

  // 2. 进入订阅页
  await page.goto(`${BASE}/subscriptions`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // 3. 点「选择月付 10 USD 立即升级」(Pro) —— 用文本定位
  const proBtn = page.locator('button', { hasText: '选择月付 10 USD' });
  console.log('Pro 按钮数量:', await proBtn.count());
  await proBtn.first().click();
  await page.waitForTimeout(2500);

  // 4. 付款方式弹窗：选 Stripe
  const stripeMethod = page.locator('button[data-pcw-method="stripe"]');
  console.log('Stripe 方式按钮数量:', await stripeMethod.count());
  await stripeMethod.first().click();
  await page.waitForTimeout(800);

  // 5. 点「继续付款」
  const payBtn = page.locator('button[data-pcw="pay"]');
  console.log('付款按钮文本:', await payBtn.first().innerText().catch(() => '(none)'));
  await payBtn.first().click();

  // 6. 等待跳转到 Stripe Checkout
  await page.waitForURL(/checkout\.stripe\./, { timeout: 20000 }).catch(() => {});
  console.log('=== 跳转后 URL ===', page.url());
  await page.waitForTimeout(3000);

  // 7. 在 Stripe Checkout 填测试卡
  const currentUrl = page.url();
  if (/checkout\.stripe\./.test(currentUrl)) {
    console.log('=== Stripe Checkout DOM ===');
    // Stripe checkout 的卡输入是 iframe 或新式嵌入式，先 dump 结构
    const bodyText = (await page.textContent('body')).slice(0, 800);
    console.log(bodyText);
    await page.screenshot({ path: 'C:/Users/zyjy2/AppData/Local/Temp/e2e-stripe.png', fullPage: true });

    // 尝试直接填卡号字段（Stripe 新版用 name="cardNumber" 等）
    for (const sel of ['input[name="cardNumber"]', 'input[name="number"]', '#cardNumber', 'input[autocomplete="cc-number"]']) {
      const f = page.locator(sel);
      if (await f.count()) {
        console.log('找到卡号输入:', sel);
        await f.first().fill(CARD);
        break;
      }
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'C:/Users/zyjy2/AppData/Local/Temp/e2e-stripe2.png', fullPage: true });
  }

  await page.waitForTimeout(5000);
  console.log('=== 最终 URL ===', page.url());
  await browser.close();
  console.log('DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
