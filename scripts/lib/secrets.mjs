/**
 * Shared secret material for the local operator scripts.
 *
 * `scripts/setup.mjs` and `scripts/generate-secret.mjs` must agree on the exact
 * shape of every generated secret, otherwise a deployment that rotates one key
 * by hand produces a value the application silently rejects. The plan requires
 * three secrets and requires that an existing `.env` is never overwritten, so
 * the generation lives here and the two entry points only decide *when* to use
 * it.
 */
import { randomBytes } from 'node:crypto';

export const secretSpecs = Object.freeze({
  BETTER_AUTH_SECRET: {
    bytes: 32,
    encoding: 'base64url',
    purpose: 'Signs sessions and the referral invite ticket.',
    minimumLength: 32,
  },
  CRON_SECRET: {
    bytes: 32,
    encoding: 'base64url',
    purpose: 'Bearer token the worker presents to /api/internal/*.',
    minimumLength: 32,
  },
  INTEGRATION_ENCRYPTION_KEY_V1: {
    bytes: 32,
    encoding: 'base64',
    purpose: 'AES-256-GCM key for withdrawal payout accounts.',
    minimumLength: 44,
  },
});

export const secretNames = Object.freeze(Object.keys(secretSpecs));

export function generateSecret(name) {
  const spec = secretSpecs[name];
  if (!spec) throw new Error(`Unknown secret: ${name}`);
  // `format: 'base64'` keeps `+`, `/` and `=` so the value is exactly 44
  // characters, which is what `keyFor()` in lib/referrals/withdrawal-crypto.ts
  // validates. The two token secrets use base64url so they survive a shell.
  return randomBytes(spec.bytes).toString(spec.encoding);
}

/**
 * Reports the state of each secret without ever returning a value. A caller
 * only needs to know whether to generate one, never what it currently is.
 */
export function inspectSecrets(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2]);
  }
  return secretNames.map((name) => {
    const value = values.get(name) ?? '';
    const spec = secretSpecs[name];
    return {
      name,
      present: value.length > 0,
      length: value.length,
      sufficient: value.length >= spec.minimumLength,
    };
  });
}

/** Replaces only the matching `NAME=` line, leaving every other byte alone. */
export function applySecrets(content, generated) {
  let next = content;
  for (const [name, value] of Object.entries(generated)) {
    if (!secretNames.includes(name)) throw new Error(`Unknown secret: ${name}`);
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    if (pattern.test(next)) next = next.replace(pattern, `${name}=${value}`);
    else next = `${next.replace(/\s*$/, '')}\n${name}=${value}\n`;
  }
  return next;
}
