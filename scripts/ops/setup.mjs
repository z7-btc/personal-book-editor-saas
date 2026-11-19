/**
 * `npm run setup`
 *
 * Creates `.env` from `.env.example` with freshly generated local secrets. The
 * plan's acceptance criterion is explicit: an existing `.env` is never
 * overwritten, and a missing secret is only added when the operator asks for it
 * (`--rotate`). Everything this script prints is a key name, never a value.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { applySecrets, generateSecret, inspectSecrets, secretNames } from './lib/secrets.mjs';

const target = new URL('../.env', import.meta.url);
const source = new URL('../.env.example', import.meta.url);
const rotate = process.argv.includes('--rotate');

function readEnv() {
  return readFile(target, 'utf8');
}

async function createFromExample() {
  const template = await readFile(source, 'utf8');
  const generated = Object.fromEntries(secretNames.map((name) => [name, generateSecret(name)]));
  await writeFile(target, applySecrets(template, generated), {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
  console.log('.env created with local development secrets.');
  for (const name of secretNames) console.log(`  ${name} = <generated>`);
  console.log('Next: npm run db:local:up && npm run db:migrate && npm run seed');
}

async function main() {
  let content;
  try {
    content = await readEnv();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await createFromExample();
    return;
  }

  const state = inspectSecrets(content);
  const missing = state.filter((entry) => !entry.sufficient);
  if (!missing.length) {
    console.log('.env already exists; every required secret is present. Nothing was changed.');
    return;
  }

  for (const entry of missing) {
    console.log(`${entry.name} is ${entry.present ? `too short (${entry.length})` : 'missing'}.`);
  }
  if (!rotate) {
    console.log('Rerun with --rotate to add the missing secrets to .env.');
    console.log('Refusing to change an existing .env otherwise, because rotating');
    console.log('BETTER_AUTH_SECRET signs out every session and rotating');
    console.log('INTEGRATION_ENCRYPTION_KEY_V1 makes stored payout accounts unreadable.');
    process.exitCode = 1;
    return;
  }

  const generated = Object.fromEntries(missing.map((entry) => [entry.name, generateSecret(entry.name)]));
  await writeFile(target, applySecrets(content, generated), { encoding: 'utf8', mode: 0o600 });
  console.log('.env updated. Generated:');
  for (const name of Object.keys(generated)) console.log(`  ${name} = <generated>`);
}

await main();
