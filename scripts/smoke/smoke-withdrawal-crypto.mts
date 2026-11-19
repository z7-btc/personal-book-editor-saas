import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { WithdrawalAccountContext } from '../../lib/referrals/withdrawal-crypto';

const module = await import('../../lib/referrals/withdrawal-crypto.ts');
const { decryptWithdrawalAccount, encryptWithdrawalAccount } =
  (module as { default?: typeof module }).default ?? module;

const context: WithdrawalAccountContext = {
  id: `wd_${randomUUID()}`, userId: randomUUID(), amount: '12.00000001',
  currency: 'USDT', method: 'BLOCKCHAIN', blockchain: 'BSC',
};
const account = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const encrypted = encryptWithdrawalAccount(context, account);
assert.ok(!encrypted.ciphertext.includes(account));
assert.equal(encrypted.mask, '0x71C7…976F');
assert.equal(decryptWithdrawalAccount(context, encrypted.keyVersion, encrypted.ciphertext), account);
assert.throws(() => decryptWithdrawalAccount(
  { ...context, amount: '13.00000001' }, encrypted.keyVersion, encrypted.ciphertext,
));
const tampered = encrypted.ciphertext.slice(0, -1) + (encrypted.ciphertext.endsWith('A') ? 'B' : 'A');
assert.throws(() => decryptWithdrawalAccount(context, encrypted.keyVersion, tampered));
console.log('Withdrawal account encryption, binding and tamper rejection passed.');
