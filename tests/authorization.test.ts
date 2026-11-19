// Authorization boundaries: who may spend on a workspace, who may change a
// subscription, which integration request is allowed to leave the process at
// all, and which caller may start a recovery runner (AC 2, 12, 20, 40).
//
// Every case here is a refusal that has to happen BEFORE useful work is done, so
// the assertions are about ordering as much as about the error: a capability
// error where an authorization error belongs would mean the check ran too late.
//
// The gates this file touches are read from the environment, so they are pinned
// at module scope and the modules under test are imported dynamically inside
// `beforeAll`: `lib/config.ts` snapshots the flags when it is first evaluated,
// and ES imports hoist above every statement in this file.
process.env.FEATURE_PAYMENT_CENTER = 'false';
process.env.FEATURE_COMMISSION_BALANCE = 'false';
process.env.FEATURE_REFERRALS = 'false';
process.env.FEATURE_REFERRAL_WITHDRAWALS = 'false';
process.env.SUBSCRIPTION_PROVIDER_SWITCH = 'disabled';

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanupFixtures,
  closeClient,
  createOrganizationFixture,
  createUserFixture,
  getClient,
  scopedId,
} from './support/fixtures';

type AccountModule = typeof import('@/lib/billing/account');
type ManagerModule = typeof import('@/lib/subscription/manager');
type IntentsModule = typeof import('@/lib/billing/intents');
type CronModule = typeof import('@/lib/jobs/cron-auth');

let account: AccountModule;
let manager: ManagerModule;
let intents: IntentsModule;
let cron: CronModule;

const scope = { userIds: [] as string[], organizationIds: [] as string[] };
const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string) {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

beforeAll(async () => {
  [account, manager, intents, cron] = await Promise.all([
    import('@/lib/billing/account'),
    import('@/lib/subscription/manager'),
    import('@/lib/billing/intents'),
    import('@/lib/jobs/cron-auth'),
  ]);
});

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanupFixtures(scope);
  await closeClient();
});

/* ------------------------------------------------------------------ helpers */

async function newUser() {
  const user = await createUserFixture();
  scope.userIds.push(user.userId);
  return user.userId;
}

async function newWorkspace(ownerUserId: string) {
  const organization = await createOrganizationFixture({ userId: ownerUserId });
  scope.organizationIds.push(organization.organizationId);
  return organization.organizationId;
}

/** Adds a non-owner membership, the state a colleague of the payer is in. */
async function joinWorkspace(organizationId: string, userId: string, role: string) {
  const client = await getClient();
  await client`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${scopedId('member')}, ${organizationId}, ${userId}, ${role}, now())`;
}

async function billingAccountRows(organizationId: string) {
  const client = await getClient();
  return client<{ id: string; original_payer_user_id: string }[]>`
    SELECT id, original_payer_user_id FROM billing_accounts
    WHERE organization_id = ${organizationId}`;
}

function changeRequest(overrides: Partial<Parameters<ManagerModule['changeSubscription']>[2]> = {}) {
  return {
    operationKey: manager.newOperationKey(),
    action: 'renew' as const,
    productCode: 'pro',
    priceInterval: 'month' as const,
    currency: 'USD',
    target: 'manual' as const,
    ...overrides,
  };
}

/* -------------------------------------------------------------------- tests */

describe('billing account ownership', () => {
  it('creates exactly one billing account for the owner and reuses it', async () => {
    const owner = await newUser();
    const organizationId = await newWorkspace(owner);

    const first = await account.ensureBillingAccount(organizationId, owner);
    expect(first.organizationId).toBe(organizationId);
    expect(first.originalPayerUserId).toBe(owner);
    // The external id the Payment Center sees is generated locally and is the
    // same string, so no look-up is needed to correlate the two systems.
    expect(first.externalBillingId).toBe(first.id);

    const second = await account.ensureBillingAccount(organizationId, owner);
    expect(second.id).toBe(first.id);
    await expect(billingAccountRows(organizationId)).resolves.toHaveLength(1);
  });

  it('refuses a member of the same workspace and writes nothing', async () => {
    const owner = await newUser();
    const organizationId = await newWorkspace(owner);
    const colleague = await newUser();
    await joinWorkspace(organizationId, colleague, 'member');

    await expect(account.ensureBillingAccount(organizationId, colleague))
      .rejects.toThrow(account.BillingAccessError);
    await expect(billingAccountRows(organizationId)).resolves.toHaveLength(0);
  });

  it('refuses an administrator and a complete stranger', async () => {
    const owner = await newUser();
    const organizationId = await newWorkspace(owner);
    const administrator = await newUser();
    await joinWorkspace(organizationId, administrator, 'admin');
    const stranger = await newUser();

    // Only the literal `owner` role passes: `admin` is not a synonym here, and
    // a missing membership row is not treated as an absent restriction.
    await expect(account.ensureBillingAccount(organizationId, administrator))
      .rejects.toThrow(account.BillingAccessError);
    await expect(account.ensureBillingAccount(organizationId, stranger))
      .rejects.toThrow(account.BillingAccessError);
    await expect(billingAccountRows(organizationId)).resolves.toHaveLength(0);
  });

  it('refuses the owner of a different workspace', async () => {
    const owner = await newUser();
    const otherOwner = await newUser();
    const organizationId = await newWorkspace(owner);
    const otherOrganizationId = await newWorkspace(otherOwner);

    // Being an owner is not a property of the user; it is a property of the
    // (workspace, user) pair, which is why the look-up matches on both.
    await expect(account.ensureBillingAccount(otherOrganizationId, owner))
      .rejects.toThrow(account.BillingAccessError);
    await expect(billingAccountRows(otherOrganizationId)).resolves.toHaveLength(0);
    // The workspace the caller does own is untouched by the refusal: the guard
    // rejects the request, it does not repair or migrate anything.
    await expect(billingAccountRows(organizationId)).resolves.toHaveLength(0);
  });
});

describe('subscription change authorization', () => {
  it('refuses a non-owner before the integration is even considered', async () => {
    const owner = await newUser();
    const organizationId = await newWorkspace(owner);
    const colleague = await newUser();
    await joinWorkspace(organizationId, colleague, 'member');

    // Payment Center is switched off for this file, so a capability error is
    // what a late authorization check would produce. Getting the access error
    // instead is the proof that the order is: authorize, then call out.
    await expect(manager.changeSubscription(organizationId, colleague, changeRequest()))
      .rejects.toThrow(account.BillingAccessError);
    await expect(billingAccountRows(organizationId)).resolves.toHaveLength(0);
  });

  it('lets the owner through the gate and stops at the disabled integration', async () => {
    const owner = await newUser();
    const organizationId = await newWorkspace(owner);

    await expect(manager.changeSubscription(organizationId, owner, changeRequest()))
      .rejects.toThrow(/paymentCenter is unavailable/);
    // The owner did reach the billing layer: that is what separates this case
    // from the refusal above.
    await expect(billingAccountRows(organizationId)).resolves.toHaveLength(1);
  });

  it('refuses a provider switch until the deployment opts in, before the owner check', async () => {
    const owner = await newUser();
    const organizationId = await newWorkspace(owner);
    const colleague = await newUser();
    await joinWorkspace(organizationId, colleague, 'member');
    const switching = changeRequest({ action: 'provider_switch', current: 'stripe' });

    expect(manager.providerSwitchAllowed()).toBe(false);
    await expect(manager.changeSubscription(organizationId, owner, switching))
      .rejects.toThrow(/disabled until the outgoing cancellation path is verified/);
    // A switch is refused even for a caller who would fail the ownership check:
    // the configuration guard is evaluated first, so an unverified deployment
    // never depends on who is asking.
    await expect(manager.changeSubscription(organizationId, colleague, switching))
      .rejects.toThrow(manager.SubscriptionChangeError);

    setEnv('SUBSCRIPTION_PROVIDER_SWITCH', 'allowed');
    expect(manager.providerSwitchAllowed()).toBe(true);
    // With the switch allowed the same call now reaches the ownership check.
    await expect(manager.changeSubscription(organizationId, colleague, switching))
      .rejects.toThrow(account.BillingAccessError);
  });

  it('a provider switch needs two different providers', async () => {
    const owner = await newUser();
    const organizationId = await newWorkspace(owner);

    for (const switching of [
      changeRequest({ action: 'provider_switch', current: null }),
      changeRequest({ action: 'provider_switch', current: 'manual', target: 'manual' }),
    ]) {
      await expect(manager.changeSubscription(organizationId, owner, switching))
        .rejects.toThrow(manager.SubscriptionChangeError);
    }
  });

  it('rejects an unparsable change before any database work', async () => {
    const owner = await newUser();
    const organizationId = await newWorkspace(owner);

    await expect(manager.changeSubscription(organizationId, owner,
      changeRequest({ currency: 'usd' }))).rejects.toThrow();
    await expect(manager.changeSubscription(organizationId, owner,
      changeRequest({ operationKey: '' }))).rejects.toThrow();
    await expect(manager.changeSubscription(organizationId, owner,
      changeRequest({ priceInterval: 'week' as 'month' }))).rejects.toThrow();
    await expect(billingAccountRows(organizationId)).resolves.toHaveLength(0);
  });
});

describe('integration capability gate', () => {
  it('refuses a disabled integration without sending a request', async () => {
    const owner = await newUser();
    const organizationId = await newWorkspace(owner);
    const send = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('a disabled integration must not reach the network');
    });

    await expect(intents.preparePaymentIntent(organizationId, owner, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'one_time',
      currency: 'USD', method: 'manual',
    })).rejects.toThrow(/paymentCenter is unavailable/);

    expect(send).not.toHaveBeenCalled();
  });
});

describe('recovery runner authorization', () => {
  const endpoint = 'http://localhost:3000/api/internal/email-center/sync';
  const request = (authorization?: string) => new Request(endpoint, {
    headers: authorization ? { authorization } : {},
  });
  const secret = 'w'.repeat(32);

  it('closes the runner unless the deployment runs in cron mode', async () => {
    // `cronFailure` answers synchronously: a failure is a Response, and only a
    // fully authorized call returns null.
    const response = cron.cronFailure(request(`Bearer ${secret}`));
    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({ error: 'runner_disabled' });
    expect(response?.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses to run with an unconfigured or too-short secret', async () => {
    process.env.RECOVERY_RUNNER_MODE = 'cron';
    delete process.env.CRON_SECRET;
    let response = cron.cronFailure(request());
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({ error: 'runner_unconfigured' });

    setEnv('CRON_SECRET', 'too-short-to-be-a-secret');
    response = cron.cronFailure(request(`Bearer ${'too-short-to-be-a-secret'}`));
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({ error: 'runner_unconfigured' });
  });

  it('accepts exactly the configured bearer and nothing else', async () => {
    process.env.RECOVERY_RUNNER_MODE = 'cron';
    setEnv('CRON_SECRET', secret);

    for (const authorization of [
      undefined,
      `Bearer ${'v'.repeat(32)}`,
      `Bearer ${secret.slice(0, 31)}`,
      `Bearer ${secret}x`,
      `bearer ${secret}`,
      `Basic ${secret}`,
      `Bearer ${'v'.repeat(1025)}`,
    ]) {
      const response = cron.cronFailure(request(authorization));
      expect(response?.status).toBe(401);
      await expect(response?.json()).resolves.toEqual({ error: 'unauthorized' });
      expect(response?.headers.get('cache-control')).toBe('no-store');
    }

    // Equal-length wrong secrets must not be distinguished from short ones, and
    // a correct secret returns "no failure" rather than a response.
    expect(cron.cronFailure(request(`Bearer ${secret}`))).toBeNull();
  });
});
