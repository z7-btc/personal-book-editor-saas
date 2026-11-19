import { createHash } from 'node:crypto';
import { requireCapability } from '@/lib/config';
import { routing } from '@/i18n/routing';

// Built from the routing table so a new locale cannot be rejected as an
// invalid password-reset callback the moment it is added.
const RESET_PATH = new RegExp(`^/(${routing.locales.join('|')})/reset-password$`);

type Mail = {
  to: string;
  subject: string;
  text: string;
  operationKey: string;
};

export async function sendTransactionalEmail(mail: Mail, send: typeof fetch = fetch) {
  requireCapability('transactionalEmail');
  const configured = process.env.TRANSACTIONAL_EMAIL_API_URL;
  if (configured && process.env.NODE_ENV === 'production') {
    throw new Error('Transactional mail URL override is forbidden in production.');
  }
  const url = configured || 'https://api.resend.com/emails';
  const response = await send(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': createHash('sha256').update(mail.operationKey).digest('hex'),
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    }),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Transactional email rejected: ${response.status}`);
  const body = await response.json() as { id?: unknown };
  if (typeof body.id !== 'string' || !body.id) {
    throw new Error('Transactional email response missing ID.');
  }
  return { id: body.id };
}

/**
 * Sends the sign-up code. The reader types it back on the registration page,
 * so the mail carries the digits themselves rather than a link. The code leads
 * the subject line so it is readable from the inbox list without opening
 * anything, and the body stays down to the code, how long it lasts, and where
 * to type it — the page already tells the reader to look in the junk folder,
 * so repeating it here would only bury the digits.
 */
export async function sendVerificationCode(to: string, code: string,
  send: typeof fetch = fetch) {
  const minutes = 10;
  await sendTransactionalEmail({
    to,
    subject: `${code} 是你的验证码 / Your verification code`,
    text: `你的验证码是：${code}\n\n`
      + `${minutes} 分钟内有效，请回到注册页面输入它完成注册。\n\n`
      + `----\n\n`
      + `Your verification code is: ${code}\n\n`
      + `It is valid for ${minutes} minutes. Enter it on the registration page to finish signing up.\n\n`
      + `If you did not request this, ignore this email.\n如果不是你发起的请求，请忽略这封邮件。`,
    operationKey: `verification-code:${to}:${code}`,
  }, send);
}

export async function sendEmailOwnershipLink(
  to: string, url: string, token: string, send: typeof fetch = fetch,
) {
  const expected = new URL(process.env.APP_BASE_URL!);
  const link = new URL(url);
  if (link.origin !== expected.origin ||
      link.pathname !== '/api/auth/verify-email' ||
      link.searchParams.get('token') !== token) {
    throw new Error('Invalid email verification link.');
  }
  link.searchParams.set('callbackURL', '/dashboard/general');
  await sendTransactionalEmail({
    to,
    subject: 'Confirm your email address / 确认邮箱归属',
    text: `Confirm your email address using this link (valid for one hour):\n${link.toString()}\n\n请点击以下链接确认邮箱归属（链接一小时内有效）：\n${link.toString()}\n\nIf you did not request this, ignore this email.\n如果不是你发起的请求，请忽略这封邮件。`,
    operationKey: `email-ownership:${token}`,
  }, send);
}

export async function sendEmailChangeConfirmation(
  to: string, newEmail: string, url: string, token: string, send: typeof fetch = fetch,
) {
  const expected = new URL(process.env.APP_BASE_URL!);
  const link = new URL(url);
  if (link.origin !== expected.origin || link.pathname !== '/api/auth/verify-email' ||
      link.searchParams.get('token') !== token) {
    throw new Error('Invalid email change confirmation link.');
  }
  link.searchParams.set('callbackURL', '/dashboard/general');
  await sendTransactionalEmail({
    to,
    subject: 'Approve email change / 确认变更邮箱',
    text: `You requested to change your sign-in email to ${newEmail}. Approve using this link (valid for one hour):\n${link.toString()}\n\n你申请将登录邮箱变更为 ${newEmail}，请点击链接确认（一小时内有效）：\n${link.toString()}\n\nAfter approval, a confirmation link will be sent to the new address.\n确认后，新邮箱还需完成归属确认。\n\nIf you did not request this, ignore this email.\n如果不是你发起的请求，请忽略这封邮件。`,
    operationKey: `email-change-confirmation:${token}`,
  }, send);
}

export async function sendPasswordResetLink(
  to: string, url: string, token: string, send: typeof fetch = fetch,
) {
  const expected = new URL(process.env.APP_BASE_URL!);
  const link = new URL(url);
  const callback = link.searchParams.get('callbackURL');
  const callbackUrl = callback ? new URL(callback, expected) : null;
  if (link.origin !== expected.origin ||
      link.pathname !== `/api/auth/reset-password/${encodeURIComponent(token)}` ||
      !callbackUrl || callbackUrl.origin !== expected.origin ||
      !RESET_PATH.test(callbackUrl.pathname) ||
      callbackUrl.search || callbackUrl.hash) {
    throw new Error('Invalid password reset link.');
  }
  await sendTransactionalEmail({
    to,
    subject: 'Reset your password / 重置密码',
    text: `Use this link to reset your password (valid for one hour):\n${link.toString()}\n\n请点击以下链接重置密码（链接一小时内有效）：\n${link.toString()}\n\nIf you did not request this, ignore this email.\n如果不是你发起的请求，请忽略这封邮件。`,
    operationKey: `password-reset:${token}`,
  }, send);
}
