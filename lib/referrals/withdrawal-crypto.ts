import 'server-only';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export type WithdrawalAccountContext = {
  id: string;
  userId: string;
  amount: string;
  currency: 'USDT';
  method: 'BINANCE_UID' | 'BLOCKCHAIN';
  blockchain: 'BSC' | 'ARBITRUM' | null;
};

function keyFor(version: string): Buffer {
  if (!/^v[1-9][0-9]*$/.test(version)) throw new Error('Invalid key version.');
  const encoded = process.env[`INTEGRATION_ENCRYPTION_KEY_${version.toUpperCase()}`];
  if (!encoded) throw new Error('Withdrawal encryption key is unavailable.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error('Withdrawal encryption key must be 32 base64 bytes.');
  }
  return key;
}

function associatedData(context: WithdrawalAccountContext): Buffer {
  return Buffer.from(JSON.stringify([
    'saas-referral-withdrawal-v1', context.id, context.userId,
    context.amount, context.currency, context.method, context.blockchain,
  ]), 'utf8');
}

export function fingerprintWithdrawalAccount(
  version: string, method: WithdrawalAccountContext['method'],
  blockchain: WithdrawalAccountContext['blockchain'], account: string,
) {
  return createHmac('sha256', keyFor(version))
    .update(JSON.stringify([method, blockchain, account])).digest('hex');
}

export function maskWithdrawalAccount(account: string, method: WithdrawalAccountContext['method']) {
  if (method === 'BLOCKCHAIN') return `${account.slice(0, 6)}…${account.slice(-4)}`;
  return `***${account.slice(-4)}`;
}

export function encryptWithdrawalAccount(context: WithdrawalAccountContext, account: string) {
  const version = process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION || 'v1';
  const key = keyFor(version);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData(context));
  const ciphertext = Buffer.concat([cipher.update(account, 'utf8'), cipher.final()]);
  return {
    keyVersion: version,
    ciphertext: [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.'),
    fingerprint: fingerprintWithdrawalAccount(version, context.method, context.blockchain, account),
    mask: maskWithdrawalAccount(account, context.method),
  };
}

export function decryptWithdrawalAccount(
  context: WithdrawalAccountContext, version: string, encoded: string,
) {
  const parts = encoded.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted withdrawal account.');
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
    throw new Error('Invalid encrypted withdrawal account.');
  }
  const decipher = createDecipheriv('aes-256-gcm', keyFor(version), iv);
  decipher.setAAD(associatedData(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
