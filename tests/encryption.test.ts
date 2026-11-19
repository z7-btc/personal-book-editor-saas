// Retry-payload encryption for referral withdrawal accounts (AC 34).
//
// The plan asks for AES-256-GCM with a versioned key (`v1`/`v2`), associated
// data that binds a ciphertext to the exact withdrawal it belongs to, and a
// rotation that leaves already-stored accounts readable. The module reads its
// key material from the environment on every call rather than snapshotting it
// at import time, so each case below sets only the variable it is about and
// restores it afterwards; the key material is generated here and never stored.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type CryptoModule = typeof import('@/lib/referrals/withdrawal-crypto');
type Context = import('@/lib/referrals/withdrawal-crypto').WithdrawalAccountContext;

let crypto: CryptoModule;

// Two distinct, canonical base64 keys of exactly 32 bytes. `keyFor` insists on
// canonical base64 (`key.toString('base64') === encoded`), which is what stops a
// base64url key from being accepted as a differently-decoded secret.
const KEY_V1 = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64');
const KEY_V2 = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)).toString('base64');

const BLOCKCHAIN_ACCOUNT = '0x9f2c4d1ab7e35f806c1d2e4a5b6c7d8e9f0a1b2c';
const EXCHANGE_ACCOUNT = '418822370';

const context: Context = {
  id: 'wi_0193a7f4c2b84e0d9a17b3c5d6e7f801',
  userId: 'user_5b8d2f0147ac4e6390b1c2d3e4f50617',
  amount: '125.500000',
  currency: 'USDT',
  method: 'BLOCKCHAIN',
  blockchain: 'BSC',
};

const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined) {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** The V1/V2 pair every case starts from, with the active version pinned to v1. */
function useBothKeys(active: 'v1' | 'v2' = 'v1') {
  setEnv('INTEGRATION_ENCRYPTION_KEY_V1', KEY_V1);
  setEnv('INTEGRATION_ENCRYPTION_KEY_V2', KEY_V2);
  setEnv('INTEGRATION_ENCRYPTION_ACTIVE_VERSION', active);
}

beforeAll(async () => {
  crypto = await import('@/lib/referrals/withdrawal-crypto');
});

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

describe('withdrawal account ciphertext', () => {
  it('encrypts into three base64url parts and reads the account back', () => {
    useBothKeys();
    const sealed = crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT);

    expect(sealed.keyVersion).toBe('v1');
    const parts = sealed.ciphertext.split('.');
    expect(parts).toHaveLength(3);
    expect(Buffer.from(parts[0]!, 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[1]!, 'base64url')).toHaveLength(16);
    expect(Buffer.from(parts[2]!, 'base64url').length).toBeGreaterThan(0);
    // A URL-safe alphabet: the value travels through a cookie-free JSON body and
    // a database column, so `+`, `/` and `=` never appear in it.
    expect(sealed.ciphertext).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    expect(crypto.decryptWithdrawalAccount(context, sealed.keyVersion, sealed.ciphertext))
      .toBe(BLOCKCHAIN_ACCOUNT);
  });

  it('stores no plaintext and publishes only a mask', () => {
    useBothKeys();
    const sealed = crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT);

    expect(sealed.ciphertext).not.toContain(BLOCKCHAIN_ACCOUNT);
    expect(sealed.ciphertext).not.toContain(BLOCKCHAIN_ACCOUNT.slice(2));
    expect(Buffer.from(sealed.ciphertext.split('.')[2]!, 'base64url').toString('utf8'))
      .not.toContain(BLOCKCHAIN_ACCOUNT);
    // Six leading and four trailing characters are kept so an operator can match
    // a payout against the account it was sent from; the middle is gone.
    expect(sealed.mask).toBe(`0x9f2c…1b2c`);
    expect(sealed.mask.length).toBeLessThan(BLOCKCHAIN_ACCOUNT.length);
  });

  it('uses a fresh IV so the same account never produces the same ciphertext twice', () => {
    useBothKeys();
    const first = crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT);
    const second = crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.ciphertext.split('.')[0]).not.toBe(second.ciphertext.split('.')[0]);
    // The fingerprint is the searchable, deterministic half: a duplicate attempt
    // is detected without ever decrypting the stored account.
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('fingerprints the account without containing it, and separates accounts and methods', () => {
    useBothKeys();
    const fingerprint = crypto.fingerprintWithdrawalAccount('v1', 'BLOCKCHAIN', 'BSC', BLOCKCHAIN_ACCOUNT);

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain(BLOCKCHAIN_ACCOUNT);
    expect(crypto.fingerprintWithdrawalAccount('v1', 'BLOCKCHAIN', 'BSC', BLOCKCHAIN_ACCOUNT))
      .toBe(fingerprint);
    expect(crypto.fingerprintWithdrawalAccount('v1', 'BLOCKCHAIN', 'BSC', BLOCKCHAIN_ACCOUNT.toUpperCase()))
      .not.toBe(fingerprint);
    expect(crypto.fingerprintWithdrawalAccount('v1', 'BINANCE_UID', null, BLOCKCHAIN_ACCOUNT))
      .not.toBe(fingerprint);
    expect(crypto.fingerprintWithdrawalAccount('v1', 'BLOCKCHAIN', 'ARBITRUM', BLOCKCHAIN_ACCOUNT))
      .not.toBe(fingerprint);
    // Keyed, not a bare digest: a different key version gives a different value.
    expect(crypto.fingerprintWithdrawalAccount('v2', 'BLOCKCHAIN', 'BSC', BLOCKCHAIN_ACCOUNT))
      .not.toBe(fingerprint);
  });

  it('masks a blockchain address and an exchange uid differently', () => {
    expect(crypto.maskWithdrawalAccount(BLOCKCHAIN_ACCOUNT, 'BLOCKCHAIN')).toBe('0x9f2c…1b2c');
    expect(crypto.maskWithdrawalAccount(EXCHANGE_ACCOUNT, 'BINANCE_UID')).toBe('***2370');
    // No leading characters of a uid are ever shown.
    expect(crypto.maskWithdrawalAccount(EXCHANGE_ACCOUNT, 'BINANCE_UID')).not.toContain('41');
  });
});

describe('associated data binds a ciphertext to one withdrawal', () => {
  it('refuses to decrypt when any bound field is changed', () => {
    useBothKeys();
    const sealed = crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT);
    const mutations: Context[] = [
      { ...context, id: 'wi_0193a7f4c2b84e0d9a17b3c5d6e7f802' },
      { ...context, userId: 'user_5b8d2f0147ac4e6390b1c2d3e4f50618' },
      { ...context, amount: '125.500001' },
      { ...context, amount: '125.5' },
      { ...context, method: 'BINANCE_UID', blockchain: null },
      { ...context, blockchain: 'ARBITRUM' },
    ];
    for (const mutation of mutations) {
      expect(() => crypto.decryptWithdrawalAccount(mutation, sealed.keyVersion, sealed.ciphertext))
        .toThrow(/authenticate/i);
    }
  });

  it('rejects a tampered iv, tag or payload', () => {
    useBothKeys();
    const sealed = crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT);
    const parts = sealed.ciphertext.split('.');

    const flip = (index: number) => {
      const bytes = Buffer.from(parts[index]!, 'base64url');
      bytes[0] = bytes[0]! ^ 0x01;
      const flipped = [...parts];
      flipped[index] = bytes.toString('base64url');
      return flipped.join('.');
    };

    for (const index of [0, 1, 2]) {
      expect(() => crypto.decryptWithdrawalAccount(context, 'v1', flip(index)))
        .toThrow(/authenticate/i);
    }
  });

  it('rejects malformed ciphertext instead of returning a partial account', () => {
    useBothKeys();
    const sealed = crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT);
    const [iv, tag, payload] = sealed.ciphertext.split('.');
    const malformed = [
      [iv, tag].join('.'),
      [iv, tag, payload, payload].join('.'),
      [iv, tag].join('.') + '.',
      [Buffer.alloc(11).toString('base64url'), tag, payload].join('.'),
      [iv, Buffer.alloc(15).toString('base64url'), payload].join('.'),
      'not-a-ciphertext',
    ];
    for (const value of malformed) {
      expect(() => crypto.decryptWithdrawalAccount(context, 'v1', value))
        .toThrow('Invalid encrypted withdrawal account.');
    }
  });
});

describe('key rotation', () => {
  it('records the active version and keeps an older ciphertext readable after a rotation', () => {
    useBothKeys('v1');
    const stored = crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT);
    expect(stored.keyVersion).toBe('v1');

    // Rotation: new writes move to v2, the version is recorded per row, and the
    // v1 key is kept configured precisely so old rows stay readable.
    useBothKeys('v2');
    const rotated = crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT);
    expect(rotated.keyVersion).toBe('v2');
    expect(crypto.decryptWithdrawalAccount(context, rotated.keyVersion, rotated.ciphertext))
      .toBe(BLOCKCHAIN_ACCOUNT);
    expect(crypto.decryptWithdrawalAccount(context, stored.keyVersion, stored.ciphertext))
      .toBe(BLOCKCHAIN_ACCOUNT);
    expect(crypto.fingerprintWithdrawalAccount('v2', 'BLOCKCHAIN', 'BSC', BLOCKCHAIN_ACCOUNT))
      .not.toBe(stored.fingerprint);
  });

  it('cannot read a ciphertext with the wrong key version', () => {
    useBothKeys();
    const sealed = crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT);
    // Same associated data, different key: the authentication tag must fail
    // rather than produce a plausible-looking account.
    expect(() => crypto.decryptWithdrawalAccount(context, 'v2', sealed.ciphertext))
      .toThrow(/authenticate/i);
  });

  it('fails closed on a missing, non-canonical or wrong-length key', () => {
    useBothKeys();
    setEnv('INTEGRATION_ENCRYPTION_KEY_V1', undefined);
    expect(() => crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT))
      .toThrow('Withdrawal encryption key is unavailable.');

    setEnv('INTEGRATION_ENCRYPTION_KEY_V1', Buffer.alloc(31, 3).toString('base64'));
    expect(() => crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT))
      .toThrow('Withdrawal encryption key must be 32 base64 bytes.');

    // 32 bytes, but spelled in the base64url alphabet: the canonical-base64
    // check is what rejects a key that would otherwise decode to the same bytes.
    setEnv('INTEGRATION_ENCRYPTION_KEY_V1', KEY_V2.replaceAll('+', '-').replaceAll('/', '_'));
    expect(() => crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT))
      .toThrow('Withdrawal encryption key must be 32 base64 bytes.');
  });

  it('rejects an invalid key version before touching the environment', () => {
    useBothKeys();
    const sealed = crypto.encryptWithdrawalAccount(context, BLOCKCHAIN_ACCOUNT);
    for (const version of ['V1', 'v0', '1', '', 'v1x']) {
      expect(() => crypto.decryptWithdrawalAccount(context, version, sealed.ciphertext))
        .toThrow('Invalid key version.');
    }
    // Shape is validated first, so a malformed value never reaches key material
    // at all — an unknown version cannot be used to probe the environment.
    expect(() => crypto.decryptWithdrawalAccount(context, 'V1', 'a.b.c'))
      .toThrow('Invalid encrypted withdrawal account.');
  });
});
