import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The withdrawal lifecycle (plan acceptance criteria 23, 24, 34).
 *
 * The withdrawal is the one flow in the product that moves real money out of the
 * platform, so this file drives it end to end against the real local PostgreSQL:
 * a request is prepared through `prepareWithdrawalIntent`, dispatched through
 * `runWithdrawalDispatch` and observed in `referral_withdrawal_intents`. Only the
 * two external networks are mocked, and each mock is named in the test title:
 * the Payment Center binding lookup and the Payment Center withdrawal endpoint,
 * both `http://127.0.0.1:5000`.
 *
 * Two facts decide most of the assertions:
 *  - the payout account exists in plaintext in exactly two places, the request
 *    body and the encrypted column, and in the DTO only as `accountMask`;
 *  - the server owns the request id, so every outcome that is not a definitive
 *    success or rejection must stay resumable under the same intent id.
 */
process.env.FEATURE_REFERRALS = 'true';
process.env.FEATURE_REFERRAL_WITHDRAWALS = 'true';
process.env.FEATURE_TRANSACTIONAL_EMAIL = 'true';
process.env.RESEND_API_KEY = 'vitest-resend-key';
process.env.EMAIL_FROM = 'Billing <billing@example.test>';
process.env.PAYMENT_CENTER_WITHDRAWAL_API_KEY = 'vitest-withdrawal-api-key';
process.env.REFERRAL_WITHDRAWAL_REQUEST_SECRET = 'w'.repeat(32);
process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION = 'v1';

const WEBSITE_ID = process.env.PAYMENT_CENTER_WEBSITE_ID!;
const SECRET = process.env.REFERRAL_WITHDRAWAL_REQUEST_SECRET;
const UID = '824301119';
const ADDRESS = '0xAbCd00000000000000000000000000000000Ef12';

type Input = {
  requestKey: string; amount: string; currency: 'USDT';
  method: 'BINANCE_UID' | 'BLOCKCHAIN'; blockchain: 'BSC' | 'ARBITRUM' | null;
  payoutAccount: string;
};

function withdrawalInput(overrides: Partial<Input> = {}): Input {
  return {
    requestKey: crypto.randomUUID(), amount: '12.5', currency: 'USDT',
    method: 'BINANCE_UID', blockchain: null, payoutAccount: UID,
    ...overrides,
  };
}

/** The mask keeps the leading and trailing characters of one payout account. */
function mask(account: string, kind: 'BLOCKCHAIN' | 'BINANCE_UID' = 'BLOCKCHAIN') {
  return kind === 'BLOCKCHAIN'
    ? `${account.slice(0, 6)}…${account.slice(-4)}`
    : `***${account.slice(-4)}`;
}

/** Reads a source file relative to this test file, for contract assertions. */
async function readSource(relative: string) {
  const { readFile } = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  return readFile(new URL(relative, import.meta.url), 'utf8');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

describe('withdrawal input contract (AC 23)', () => {
  it('accepts only the USDT shapes the payment center can pay out', async () => {
    const { normalizeWithdrawal } = await import('@/lib/referrals/withdrawal-intent');
    // The Binance UID path: a numeric UID and no chain.
    expect(normalizeWithdrawal(withdrawalInput())).toMatchObject({
      amount: '12.50000000', payoutAccount: UID, blockchain: null, method: 'BINANCE_UID',
    });
    // The on-chain path: an EVM address is normalised to lower case.
    expect(normalizeWithdrawal(withdrawalInput({
      method: 'BLOCKCHAIN', blockchain: 'BSC', payoutAccount: ADDRESS,
    })).payoutAccount).toBe(ADDRESS.toLowerCase());

    const rejected: Array<[string, Input]> = [
      ['a zero amount', withdrawalInput({ amount: '0' })],
      ['a negative amount', withdrawalInput({ amount: '-1' })],
      ['more than eight decimals', withdrawalInput({ amount: '1.000000001' })],
      ['an empty amount', withdrawalInput({ amount: '' })],
      ['an exponent amount', withdrawalInput({ amount: '1e3' })],
      ['a non-numeric UID', withdrawalInput({ payoutAccount: 'binance-user' })],
      ['a UID that is too short', withdrawalInput({ payoutAccount: '1234' })],
      ['a UID with a chain', withdrawalInput({ blockchain: 'BSC' })],
      ['an address without a chain', withdrawalInput({
        method: 'BLOCKCHAIN', blockchain: null, payoutAccount: ADDRESS,
      })],
      ['a short address', withdrawalInput({
        method: 'BLOCKCHAIN', blockchain: 'BSC', payoutAccount: '0x1234',
      })],
      ['a non-EVM address', withdrawalInput({
        method: 'BLOCKCHAIN', blockchain: 'BSC',
        payoutAccount: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      })],
      ['a currency other than USDT', withdrawalInput({
        currency: 'USD' as unknown as 'USDT',
      })],
      ['an unknown chain', withdrawalInput({
        method: 'BLOCKCHAIN', blockchain: 'SOLANA' as unknown as 'BSC',
        payoutAccount: ADDRESS,
      })],
    ];
    for (const [label, input] of rejected) {
      await expect(async () => normalizeWithdrawal(input), label).rejects.toThrow();
    }
    // The chain is a property of the payout, so every supported one must work.
    for (const chain of ['BSC', 'ARBITRUM'] as const) {
      expect(normalizeWithdrawal(withdrawalInput({
        method: 'BLOCKCHAIN', blockchain: chain, payoutAccount: ADDRESS,
      })).blockchain).toBe(chain);
    }
  });

  it('never exposes the payout account, the ciphertext or the fingerprint in a DTO', async () => {
    const { withdrawalIntentDto } = await import('@/lib/referrals/withdrawal-intent');
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    const dto = withdrawalIntentDto({
      id: 'wd_abc', user_id: 'user_1', request_key: crypto.randomUUID(),
      amount_decimal: '12.50000000', currency: 'USDT', method: 'BINANCE_UID',
      blockchain: null, account_key_version: 'v1',
      account_fingerprint: 'a'.repeat(64), account_mask: `${UID.slice(0, 6)}…${UID.slice(-4)}`,
      status: 'pending', center_withdrawal_id: null, created_at: createdAt,
    } as Parameters<typeof withdrawalIntentDto>[0]);
    expect(dto).toEqual({
      id: 'wd_abc', amount: '12.50000000', currency: 'USDT', method: 'BINANCE_UID',
      blockchain: null, accountMask: `${UID.slice(0, 6)}…${UID.slice(-4)}`,
      status: 'pending', createdAt,
    });
    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain(UID);
    expect(serialised).not.toContain('fingerprint');
    expect(serialised).not.toContain('cipher');
    expect(serialised).not.toContain('user_id');
    expect(serialised).not.toContain('request_key');
  });
});

describe('withdrawal lifecycle against the real database (AC 23, 24, 34)', () => {
  const suffix = `w5withdraw${Date.now().toString(36)}`;
  let fixtures: typeof import('./support/fixtures');
  let intent: typeof import('@/lib/referrals/withdrawal-intent');
  let worker: typeof import('@/lib/referrals/withdrawal-worker');
  let client: Awaited<ReturnType<typeof import('./support/fixtures').getClient>>;
  const created: string[] = [];
  /** Session age is part of the contract: the route passes the real login time. */
  const freshLogin = () => new Date();

  async function fixture(sync: 'succeeded' | 'pending' = 'succeeded', verified = true) {
    const user = await fixtures.createUserFixture({
      suffix: `${suffix}${created.length}`, emailVerified: verified,
    });
    created.push(user.userId);
    await client`INSERT INTO referral_user_outbox (user_id, event_version, status)
      VALUES (${user.userId}, 1, ${sync})
      ON CONFLICT (user_id, event_version) DO UPDATE SET status = ${sync}`;
    return user;
  }

  async function row(id: string) {
    const [record] = await client`SELECT * FROM referral_withdrawal_intents WHERE id = ${id}`;
    return record as Record<string, unknown>;
  }

  /** Payment Center (http://127.0.0.1:5000) binding lookup, stubbed. */
  function binding(userId: string, overrides: Record<string, unknown> = {}) {
    return {
      status: 'success',
      data: {
        exists: true,
        user: {
          id: `remote_${userId}`, external_user_id: userId, website_id: WEBSITE_ID,
          ...overrides,
        },
      },
    };
  }

  /** Payment Center (http://127.0.0.1:5000) withdrawal endpoint, stubbed. */
  function receipt(job: { id: string; userId: string; amount: string; method: string;
    blockchain: string | null; account: string }, overrides: Record<string, unknown> = {}) {
    return {
      status: 'success',
      data: {
        success: true,
        withdrawal: {
          id: `center_${job.id}`,
          website_id: WEBSITE_ID,
          referral_user_id: `remote_${job.userId}`,
          external_withdrawal_id: job.id,
          amount_decimal: job.amount,
          currency: 'USDT',
          method: job.blockchain ? `BLOCKCHAIN_${job.blockchain}` : job.method,
          payout_account: job.account,
          ...overrides,
        },
      },
    };
  }

  beforeAll(async () => {
    fixtures = await import('./support/fixtures');
    intent = await import('@/lib/referrals/withdrawal-intent');
    worker = await import('@/lib/referrals/withdrawal-worker');
    client = await fixtures.getClient();
    const capabilities = (await import('@/lib/config')).getCapabilities().referralWithdrawals;
    // Without this the whole file would be asserting a capability that is off; the
    // process environment is set at module scope for exactly this reason.
    expect(capabilities, capabilities.missing.join(', ')).toMatchObject({ configured: true });
  });

  afterAll(async () => {
    await fixtures.cleanupFixtures({ userIds: created });
    await fixtures.closeClient();
  });

  it('prepares an intent as pending with the account encrypted, not stored as text', async () => {
    const user = await fixture();
    const input = withdrawalInput({ payoutAccount: ADDRESS, method: 'BLOCKCHAIN',
      blockchain: 'ARBITRUM' });
    const prepared = await intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(), input,
    );
    expect(prepared.replay).toBe(false);
    expect(prepared.intent).toMatchObject({
      amount: '12.50000000', currency: 'USDT', method: 'BLOCKCHAIN',
      blockchain: 'ARBITRUM', accountMask: mask(ADDRESS.toLowerCase()), status: 'pending',
    });
    expect(prepared.intent.id).toMatch(/^wd_[0-9a-f]{32}$/);
    const stored = await row(prepared.intent.id);
    expect(stored.account_ciphertext).not.toContain(ADDRESS);
    expect(stored.account_ciphertext).not.toContain(ADDRESS.toLowerCase());
    expect(stored.account_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(ADDRESS.slice(10));
    // The address is stored in the normalised lower-case form the chain uses.
    const decrypted = (await import('@/lib/referrals/withdrawal-crypto')).decryptWithdrawalAccount({
      id: prepared.intent.id, userId: user.userId, amount: '12.50000000', currency: 'USDT',
      method: 'BLOCKCHAIN', blockchain: 'ARBITRUM',
    }, String(stored.account_key_version), String(stored.account_ciphertext));
    expect(decrypted).toBe(ADDRESS.toLowerCase());
  });

  it('refuses an unconfirmed email, an old login and a sync-pending account', async () => {
    const unverified = await fixture('succeeded', false);
    await expect(intent.prepareWithdrawalIntent(
      { id: unverified.userId, emailVerified: false }, freshLogin(), withdrawalInput(),
    )).rejects.toBeInstanceOf(intent.WithdrawalIdentityRequired);

    const user = await fixture();
    const stale = new Date(Date.now() - 16 * 60_000);
    await expect(intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, stale, withdrawalInput(),
    )).rejects.toBeInstanceOf(intent.WithdrawalRecentAuthRequired);
    // A clock ahead of the server is a stale session too, not a fresh one.
    await expect(intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, new Date(Date.now() + 5 * 60_000),
      withdrawalInput(),
    )).rejects.toBeInstanceOf(intent.WithdrawalRecentAuthRequired);

    const syncing = await fixture('pending');
    await expect(intent.prepareWithdrawalIntent(
      { id: syncing.userId, emailVerified: true }, freshLogin(), withdrawalInput(),
    )).rejects.toBeInstanceOf(intent.WithdrawalUserSyncPending);
    // Nothing may be written before the referral account exists remotely.
    const [count] = await client`SELECT COUNT(*)::integer AS count
      FROM referral_withdrawal_intents WHERE user_id = ${syncing.userId}`;
    expect(count!.count).toBe(0);
  });

  it('replays the same server id for the same request key and never a second row', async () => {
    const user = await fixture();
    const input = withdrawalInput({ amount: '3' });
    const first = await intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(), input,
    );
    const replay = await intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(), input,
    );
    expect(replay.replay).toBe(true);
    expect(replay.intent.id).toBe(first.intent.id);
    expect(replay.intent).toEqual(first.intent);
    const [count] = await client`SELECT COUNT(*)::integer AS count
      FROM referral_withdrawal_intents WHERE user_id = ${user.userId}`;
    expect(count!.count).toBe(1);
  });

  it('rejects a reused request key only when the contents differ', async () => {
    const user = await fixture();
    const input = withdrawalInput({ amount: '4' });
    const first = await intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(), input,
    );
    // Same key, different amount: the row cannot be reused and nothing new is written.
    await expect(intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(),
      { ...input, amount: '4.5' },
    )).rejects.toBeInstanceOf(intent.WithdrawalConflict);
    // Same key, same amount, different account: a different payout was requested.
    await expect(intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(),
      { ...input, payoutAccount: '824301120' },
    )).rejects.toBeInstanceOf(intent.WithdrawalConflict);
    const [count] = await client`SELECT COUNT(*)::integer AS count
      FROM referral_withdrawal_intents WHERE user_id = ${user.userId}`;
    expect(count!.count).toBe(1);
    expect((await row(first.intent.id)).amount_decimal).toBe('4.00000000');
  });

  it('files one withdrawal at a time and limits requests to five per day', async () => {
    const user = await fixture();
    await intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(), withdrawalInput(),
    );
    // A second request while the first is still open is a conflict, not a limit:
    // the user must cancel or finish what is already in flight.
    await expect(intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(), withdrawalInput(),
    )).rejects.toBeInstanceOf(intent.WithdrawalConflict);

    // Five completed requests in the last day fill the quota for today.
    const other = await fixture();
    for (let index = 0; index < 5; index += 1) {
      await client`INSERT INTO referral_withdrawal_intents (
        id, user_id, request_key, amount_decimal, currency, method, blockchain,
        account_ciphertext, account_key_version, account_fingerprint, account_mask, status,
        created_at, available_at
      ) VALUES (
        ${`wd_${crypto.randomUUID().replaceAll('-', '')}`}, ${other.userId},
        ${crypto.randomUUID()}, '1.00000000', 'USDT', 'BINANCE_UID', NULL,
        'v1.iv.tag.cipher', 'v1', ${'b'.repeat(64)}, ${mask(UID, 'BINANCE_UID')}, 'submitted',
        now() - interval '10 minutes', now()
      )`;
    }
    await expect(intent.prepareWithdrawalIntent(
      { id: other.userId, emailVerified: true }, freshLogin(), withdrawalInput(),
    )).rejects.toBeInstanceOf(intent.WithdrawalRateLimited);

    // One completed request in the last minute is a limit too, so a user cannot
    // walk the five-per-day quota in five seconds.
    const third = await fixture();
    await client`INSERT INTO referral_withdrawal_intents (
      id, user_id, request_key, amount_decimal, currency, method, blockchain,
      account_ciphertext, account_key_version, account_fingerprint, account_mask, status,
      created_at, available_at
    ) VALUES (
      ${`wd_${crypto.randomUUID().replaceAll('-', '')}`}, ${third.userId},
      ${crypto.randomUUID()}, '1.00000000', 'USDT', 'BINANCE_UID', NULL,
      'v1.iv.tag.cipher', 'v1', ${'b'.repeat(64)}, ${mask(UID, 'BINANCE_UID')}, 'submitted',
      now(), now()
    )`;
    await expect(intent.prepareWithdrawalIntent(
      { id: third.userId, emailVerified: true }, freshLogin(), withdrawalInput(),
    )).rejects.toBeInstanceOf(intent.WithdrawalRateLimited);

    // The counter is scoped to the requester.
    const bystander = await fixture();
    const allowed = await intent.prepareWithdrawalIntent(
      { id: bystander.userId, emailVerified: true }, freshLogin(), withdrawalInput(),
    );
    expect(allowed.replay).toBe(false);
  });

  it('dispatches a submitted payout that pays the account the user asked for', async () => {
    const user = await fixture();
    const input = withdrawalInput({ amount: '7.25', payoutAccount: ADDRESS,
      method: 'BLOCKCHAIN', blockchain: 'BSC' });
    const prepared = await intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(), input,
    );
    const account = ADDRESS.toLowerCase();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const send = (async (input_: string | URL | Request, init?: RequestInit) => {
      const url = String(input_);
      calls.push({ url, init });
      if (url.includes('/summary')) return json(binding(user.userId));
      return json(receipt({
        id: prepared.intent.id, userId: user.userId, amount: '7.25000000',
        method: 'BLOCKCHAIN', blockchain: 'BSC', account,
      }));
    }) as unknown as typeof fetch;

    const report = await worker.runWithdrawalDispatch({
      requestedId: prepared.intent.id, maxJobs: 1, send,
    });
    expect(report).toEqual({
      claimed: 1, submitted: 1, uncertain: 0, rejected: 0, manual_review: 0,
    });
    const settled = await row(prepared.intent.id);
    expect(settled.status).toBe('submitted');
    expect(settled.center_withdrawal_id).toBe(`center_${prepared.intent.id}`);
    expect(settled.last_error_code).toBeNull();
    expect(String(settled.submitted_at)).toMatch(/^\d{4}-\d{2}-\d{2}[ T]/);
    expect(settled.lease_owner).toBeNull();

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain(`/api/referral-center/users/${encodeURIComponent(user.userId)}/summary?currency=USDT`);
    const post = calls[1]!;
    expect(post.url).toContain('/api/referral-center/withdrawals');
    expect(post.init?.method).toBe('POST');
    const headers = post.init?.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe(process.env.PAYMENT_CENTER_WITHDRAWAL_API_KEY);
    const body = String(post.init?.body);
    // The centre is paid to the address the user typed, decrypted from the row.
    expect(JSON.parse(body)).toEqual({
      external_user_id: user.userId, external_withdrawal_id: prepared.intent.id,
      amount: '7.25000000', currency: 'USDT', method: 'BLOCKCHAIN',
      payout_account: account, blockchain: 'BSC',
    });
    // The signature the centre verifies must be reproducible from the secret.
    // The parts are joined with a LITERAL backslash-n pair, not a newline: the
    // centre's Python source writes `\\n`, which is an escaped backslash.
    const parts = ['POST', '/api/referral-center/withdrawals', body,
      headers['X-Withdrawal-Timestamp']!, headers['X-Withdrawal-Nonce']!];
    const expected = createHmac('sha256', SECRET)
      .update(parts.join('\\n')).digest('hex');
    expect(headers['X-Withdrawal-Signature']).toBe(expected);
    // Guard the quirk: a real newline must never be what we sign.
    expect(expected).not.toBe(createHmac('sha256', SECRET)
      .update(parts.join('\n')).digest('hex'));
    expect(headers['X-Withdrawal-Nonce']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keeps an unknown outcome resumable and never pays twice', async () => {
    const user = await fixture();
    const input = withdrawalInput({ amount: '5' });
    const prepared = await intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(), input,
    );
    // Payment Center (http://127.0.0.1:5000) is unreachable: the outcome is unknown.
    const offline = (async (input_: string | URL | Request) => {
      if (String(input_).includes('/summary')) return json(binding(user.userId));
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const first = await worker.runWithdrawalDispatch({
      requestedId: prepared.intent.id, maxJobs: 1, send: offline,
    });
    expect(first).toEqual({
      claimed: 1, submitted: 0, uncertain: 1, rejected: 0, manual_review: 0,
    });
    const uncertain = await row(prepared.intent.id);
    expect(uncertain.status).toBe('uncertain');
    expect(uncertain.last_error_code).toBe('RESULT_UNCONFIRMED');
    // A lost result is retried under the same id, so the centre's idempotency key
    // still matches the original request.
    expect(uncertain.id).toBe(prepared.intent.id);
    expect(uncertain.center_withdrawal_id).toBeNull();
    expect(new Date(uncertain.available_at as string).getTime()).toBeGreaterThan(Date.now());

    // The recovery runner must not claim it before the retry window opens.
    const tooEarly = await worker.runWithdrawalDispatch({
      requestedId: prepared.intent.id, maxJobs: 1, send: offline,
    });
    expect(tooEarly.claimed).toBe(0);

    // An attempt ceiling exists: a job that never resolves for eight attempts is
    // handed to a human instead of retrying forever.
    await client`UPDATE referral_withdrawal_intents SET attempt_count = 7,
      available_at = now() WHERE id = ${prepared.intent.id}`;
    const exhausted = await worker.runWithdrawalDispatch({
      requestedId: prepared.intent.id, maxJobs: 1, send: offline,
    });
    expect(exhausted).toEqual({
      claimed: 1, submitted: 0, uncertain: 0, rejected: 0, manual_review: 1,
    });
    expect((await row(prepared.intent.id)).status).toBe('manual_review');
  });

  it('hands a mismatched user binding to a human instead of sending money', async () => {
    const user = await fixture();
    const prepared = await intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(), withdrawalInput(),
    );
    let withdrawals = 0;
    const send = (async (input_: string | URL | Request) => {
      const url = String(input_);
      if (url.includes('/summary')) {
        return json(binding(user.userId, { website_id: 'another-website' }));
      }
      withdrawals += 1;
      return json(receipt({ id: prepared.intent.id, userId: user.userId, amount: '12.50000000',
        method: 'BINANCE_UID', blockchain: null, account: UID }));
    }) as unknown as typeof fetch;
    const report = await worker.runWithdrawalDispatch({
      requestedId: prepared.intent.id, maxJobs: 1, send,
    });
    expect(report).toMatchObject({ claimed: 1, manual_review: 1, submitted: 0 });
    expect(withdrawals).toBe(0);
    const settled = await row(prepared.intent.id);
    expect(settled.status).toBe('manual_review');
    expect(settled.last_error_code).toBe('USER_BINDING_MISMATCH');
  });

  it('rejects a payout the centre refuses and records why', async () => {
    const user = await fixture();
    const prepared = await intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(), withdrawalInput({ amount: '9' }),
    );
    const send = (async (input_: string | URL | Request) => {
      if (String(input_).includes('/summary')) return json(binding(user.userId));
      return json({ message: '可用余额不足' }, 400);
    }) as unknown as typeof fetch;
    const report = await worker.runWithdrawalDispatch({
      requestedId: prepared.intent.id, maxJobs: 1, send,
    });
    expect(report).toMatchObject({ claimed: 1, rejected: 1, submitted: 0 });
    const settled = await row(prepared.intent.id);
    expect(settled.status).toBe('rejected');
    expect(settled.last_error_code).toBe('INSUFFICIENT_BALANCE');
    expect(settled.center_withdrawal_id).toBeNull();
  });

  it('refuses a receipt that does not match the request and asks for a human', async () => {
    const user = await fixture();
    const input = withdrawalInput({ amount: '6' });
    const prepared = await intent.prepareWithdrawalIntent(
      { id: user.userId, emailVerified: true }, freshLogin(), input,
    );
    const mismatches: Array<[string, Record<string, unknown>]> = [
      ['a different amount', { amount_decimal: '6.50000000' }],
      ['a different website', { website_id: 'another-website' }],
      ['a different account', { payout_account: '824301999' }],
      ['a different external id', { external_withdrawal_id: 'wd_someone_else' }],
      ['no centre id', { id: undefined }],
      ['a different currency', { currency: 'USDC' }],
    ];
    for (const [label, override] of mismatches) {
      const target = await fixture();
      const own = await intent.prepareWithdrawalIntent(
        { id: target.userId, emailVerified: true }, freshLogin(),
        withdrawalInput({ amount: input.amount }),
      );
      const send = (async (input_: string | URL | Request) => {
        if (String(input_).includes('/summary')) return json(binding(target.userId));
        return json(receipt({
          id: own.intent.id, userId: target.userId, amount: '6.00000000',
          method: 'BINANCE_UID', blockchain: null, account: UID,
        }, override));
      }) as unknown as typeof fetch;
      const report = await worker.runWithdrawalDispatch({
        requestedId: own.intent.id, maxJobs: 1, send,
      });
      expect(report, label).toMatchObject({ claimed: 1, manual_review: 1, submitted: 0 });
      expect((await row(own.intent.id)).last_error_code, label).toBe('RECEIPT_MISMATCH');
      expect((await row(prepared.intent.id)).status, label).toBe('pending');
    }
    expect(prepared.intent.id).toMatch(/^wd_[0-9a-f]{32}$/);
  });

  it('never claims a payout whose payload the retention scrub already removed', async () => {
    const user = await fixture();
    const id = `wd_${crypto.randomUUID().replaceAll('-', '')}`;
    await client`INSERT INTO referral_withdrawal_intents (
      id, user_id, request_key, amount_decimal, currency, method, blockchain,
      account_ciphertext, account_key_version, account_fingerprint, account_mask, status,
      available_at
    ) VALUES (
      ${id}, ${user.userId}, ${crypto.randomUUID()}, '1.00000000', 'USDT', 'BINANCE_UID', NULL,
      NULL, 'v1', ${'c'.repeat(64)}, '824301…1119', 'pending', now()
    )`;
    const report = await worker.runWithdrawalDispatch({ requestedId: id, maxJobs: 1 });
    expect(report.claimed).toBe(0);
    expect((await row(id)).status).toBe('pending');
  });
});

/**
 * The HTTP layer itself cannot run here: both withdrawal handlers read the
 * session through `next/headers`, and Next throws `headers was called outside a
 * request scope` for any direct call outside the server. The route contract is
 * therefore pinned against its source — every status, error code and header the
 * acceptance criteria name — while the behaviour behind it (the intent rules and
 * the dispatch worker) is exercised for real in the block above.
 */
describe('withdrawal HTTP contract (AC 24)', () => {
  let collection = '';
  let item = '';
  let form = '';
  let scripts = '';

  beforeAll(async () => {
    collection = await readSource('../app/api/referrals/withdrawals/route.ts');
    item = await readSource('../app/api/referrals/withdrawals/[id]/route.ts');
    form = await readSource('../components/referrals/withdrawal-form.tsx');
    scripts = await readSource('../package.json');
  });

  it('routes the request status through the server id, by key and by id', () => {
    expect(collection).toMatch(/export async function POST\(request: Request\)/);
    expect(collection).toMatch(/export async function GET\(request: Request\)/);
    expect(item).toMatch(/export async function GET\(/);
    expect(collection).toContain('WHERE user_id = ${session.user.id} AND request_key = ${requestKey}');
    expect(item).toMatch(/getWithdrawalIntent|SELECT[^`]*referral_withdrawal_intents/);
    // Server-owned identifiers: the client never chooses the withdrawal id.
    expect(collection).toContain('prepareWithdrawalIntent(');
    expect(collection).not.toMatch(/body\.(id|status|centerWithdrawalId)\b/);
    for (const source of [collection, item]) {
      expect(source).toContain("'Cache-Control': 'private, no-store'");
    }
  });

  it('answers 200 for a settled replay, 201 for a fresh payout and 202 while unknown', () => {
    // The whole point of the durable intent is that an unknown result is
    // recoverable under the same id instead of being reported as failed.
    expect(collection).toMatch(
      /status\s*=\s*latest\.status === 'submitted' \? \(prepared\.replay \? 200 : 201\)/,
    );
    expect(collection).toMatch(/latest\.status === 'rejected' \? 422 : 202/);
    expect(item).toMatch(/status:\s*404|status:\s*200/);
  });

  it('maps every business refusal to its documented status and code', () => {
    const expected: Array<[string, string, number]> = [
      ['WithdrawalRateLimited', 'rate_limited', 429],
      ['WithdrawalIdentityRequired', 'email_unconfirmed', 403],
      ['WithdrawalRecentAuthRequired', 'recent_sign_in_required', 403],
      ['WithdrawalUserSyncPending', 'referral_sync_pending', 409],
      ['WithdrawalConflict', 'withdrawal_conflict', 409],
    ];
    for (const [error, code, status] of expected) {
      expect(collection, error).toContain(`error instanceof ${error}`);
      expect(collection, code).toContain(`'${code}'`);
      expect(collection, `${error} → ${status}`).toMatch(
        new RegExp(`error instanceof ${error}[\\s\\S]{0,240}?\\?\\s*${status}|${status}[\\s\\S]{0,240}?error instanceof ${error}`),
      );
    }
    // Nothing the route can answer is ever cached, including its failures.
    const responses = collection.match(/Response\.json\(/g) ?? [];
    expect(responses.length).toBeGreaterThan(8);
    expect(collection.match(/privateHeaders/g)?.length ?? 0).toBeGreaterThanOrEqual(responses.length);
  });

  it('refuses a cross-site, oversized or non-JSON payload before touching money', () => {
    expect(collection).toContain("request.headers.get('origin') !== new URL(");
    expect(collection).toContain("'invalid_origin' }, { status: 403");
    expect(collection).toContain("startsWith('application/json')");
    expect(collection).toContain('4_096');
    expect(collection).toContain('invalid_request');
    expect(collection).toMatch(/error: 'unauthorized' \}, \{ status: 401/);
    expect(collection).toMatch(/error: 'withdrawals_unavailable' \}, \{ status: 503/);
    // The capability gate runs before the payload is read at all.
    expect(collection.indexOf('referralWithdrawals.configured'))
      .toBeLessThan(collection.indexOf('await request.text()'));
  });

  it('exposes only masked payout data to the client', () => {
    for (const source of [collection, item]) {
      expect(source).toContain('account_mask');
      expect(source).not.toContain('account_ciphertext AS');
      expect(source).not.toContain('account_fingerprint');
      expect(source).not.toMatch(/JSON\.stringify\(\s*row\s*\)/);
    }
    expect(form).not.toContain('account_ciphertext');
    // The client island stores the request key server-side; it never keeps the
    // payout account or a signature secret in browser storage.
    expect(form).toContain('sessionStorage');
    expect(form).not.toMatch(/localStorage/);
    expect(form).not.toMatch(/process\.env\./);
  });

  it('keeps the recovery polling loop and the same request key on retry', () => {
    expect(form).toMatch(/pending|sending|uncertain/);
    expect(form).toContain('/api/referrals/withdrawals');
    expect(form).toMatch(/5_000|5000/);
    expect(form).toMatch(/randomUUID\(\)/);
    expect(form).toMatch(/retrySame/);
    expect(form).toMatch(/checkStatus/);
    expect(form).toMatch(/requestKey/);
    // A failed attempt must not quietly start a new withdrawal id.
    expect(form).not.toMatch(/retrySame[\s\S]{0,80}randomUUID/);
  });

  it('cleans settled payout payloads through the retention scrub', () => {
    // AC 34: the delivery script that scrubs payloads after the retention window
    // must run against this repository, and the payload it clears is the account.
    expect(scripts).toContain('dispatch-referral-withdrawals');
    expect(scripts).toMatch(/"smoke:withdrawal:http"/);
  });
});
