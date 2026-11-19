import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireCapability } from '@/lib/config';
import { client } from '@/lib/db/drizzle';
import {
  encryptWithdrawalAccount, fingerprintWithdrawalAccount,
  type WithdrawalAccountContext,
} from './withdrawal-crypto';

const inputSchema = z.object({
  requestKey: z.uuid(),
  amount: z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/),
  currency: z.literal('USDT'),
  method: z.enum(['BINANCE_UID', 'BLOCKCHAIN']),
  blockchain: z.enum(['BSC', 'ARBITRUM']).nullable(),
  payoutAccount: z.string().trim().min(1).max(100),
});

export type WithdrawalInput = z.infer<typeof inputSchema>;
export class WithdrawalConflict extends Error {}
export class WithdrawalRecentAuthRequired extends Error {}
export class WithdrawalIdentityRequired extends Error {}
export class WithdrawalRateLimited extends Error {}
export class WithdrawalUserSyncPending extends Error {}
export class WithdrawalInvalidInput extends Error {}

export function normalizeWithdrawal(input: WithdrawalInput) {
  const value = inputSchema.parse(input);
  const [whole, fractional = ''] = value.amount.split('.');
  const minor = BigInt(whole) * 100_000_000n + BigInt(fractional.padEnd(8, '0'));
  if (minor <= 0n) throw new WithdrawalInvalidInput('Withdrawal amount must be positive.');
  if (value.method === 'BINANCE_UID') {
    if (value.blockchain !== null || !/^\d{5,20}$/.test(value.payoutAccount)) {
      throw new WithdrawalInvalidInput('Invalid Binance UID.');
    }
  } else if (!value.blockchain || !/^0x[0-9a-fA-F]{40}$/.test(value.payoutAccount)) {
    throw new WithdrawalInvalidInput('Invalid EVM withdrawal address or chain.');
  }
  return {
    ...value,
    amount: `${whole}.${fractional.padEnd(8, '0')}`,
    payoutAccount: value.method === 'BLOCKCHAIN'
      ? value.payoutAccount.toLowerCase() : value.payoutAccount,
  };
}

type IntentRow = {
  id: string; user_id: string; request_key: string; amount_decimal: string;
  currency: 'USDT'; method: 'BINANCE_UID' | 'BLOCKCHAIN';
  blockchain: 'BSC' | 'ARBITRUM' | null; account_key_version: string;
  account_fingerprint: string; account_mask: string; status: string;
  center_withdrawal_id: string | null; created_at: Date;
};

export function withdrawalIntentDto(row: IntentRow) {
  return {
    id: row.id,
    amount: row.amount_decimal,
    currency: row.currency,
    method: row.method,
    blockchain: row.blockchain,
    accountMask: row.account_mask,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function prepareWithdrawalIntent(
  user: { id: string; emailVerified: boolean },
  sessionCreatedAt: Date | string,
  input: WithdrawalInput,
) {
  requireCapability('referralWithdrawals');
  if (!user.emailVerified) throw new WithdrawalIdentityRequired('Email ownership is unconfirmed.');
  const loginAt = new Date(sessionCreatedAt).getTime();
  if (!Number.isFinite(loginAt) || loginAt > Date.now() + 60_000 ||
      Date.now() - loginAt > 15 * 60_000) {
    throw new WithdrawalRecentAuthRequired('Sign in again before withdrawing.');
  }
  const normalized = normalizeWithdrawal(input);
  const id = `wd_${randomUUID().replaceAll('-', '')}`;
  const context: WithdrawalAccountContext = {
    id, userId: user.id, amount: normalized.amount, currency: 'USDT',
    method: normalized.method, blockchain: normalized.blockchain,
  };
  const encrypted = encryptWithdrawalAccount(context, normalized.payoutAccount);

  return client.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
    const [prior] = await tx<IntentRow[]>`
      SELECT * FROM referral_withdrawal_intents
      WHERE user_id = ${user.id} AND request_key = ${normalized.requestKey}
    `;
    if (prior) {
      const expectedFingerprint = fingerprintWithdrawalAccount(
        prior.account_key_version, normalized.method, normalized.blockchain,
        normalized.payoutAccount,
      );
      if (prior.amount_decimal !== normalized.amount || prior.currency !== 'USDT' ||
          prior.method !== normalized.method || prior.blockchain !== normalized.blockchain ||
          prior.account_fingerprint !== expectedFingerprint) {
        throw new WithdrawalConflict('Request key was used for another withdrawal.');
      }
      return { intent: withdrawalIntentDto(prior), replay: true };
    }
    const [profile] = await tx`
      SELECT p.user_id FROM referral_profiles p
      WHERE p.user_id = ${user.id} AND (
        SELECT status::text FROM referral_user_outbox
        WHERE user_id = p.user_id ORDER BY event_version DESC LIMIT 1
      ) = 'succeeded'
    `;
    if (!profile) throw new WithdrawalUserSyncPending('Referral account is still syncing.');
    const [open] = await tx`
      SELECT id FROM referral_withdrawal_intents
      WHERE user_id = ${user.id} AND status IN ('pending', 'sending', 'uncertain')
      LIMIT 1
    `;
    if (open) throw new WithdrawalConflict('Another withdrawal is still being confirmed.');
    const [recent] = await tx`
      SELECT COUNT(*)::integer AS day_count,
             COUNT(*) FILTER (WHERE created_at > now() - interval '1 minute')::integer AS minute_count
      FROM referral_withdrawal_intents
      WHERE user_id = ${user.id} AND created_at > now() - interval '1 day'
    `;
    if (Number(recent.day_count) >= 5 || Number(recent.minute_count) >= 1) {
      throw new WithdrawalRateLimited('Withdrawal request limit reached.');
    }
    const [created] = await tx<IntentRow[]>`
      INSERT INTO referral_withdrawal_intents (
        id, user_id, request_key, amount_decimal, currency, method, blockchain,
        account_ciphertext, account_key_version, account_fingerprint, account_mask
      ) VALUES (
        ${id}, ${user.id}, ${normalized.requestKey}, ${normalized.amount}, 'USDT',
        ${normalized.method}, ${normalized.blockchain}, ${encrypted.ciphertext},
        ${encrypted.keyVersion}, ${encrypted.fingerprint}, ${encrypted.mask}
      ) RETURNING *
    `;
    return { intent: withdrawalIntentDto(created), replay: false };
  });
}
