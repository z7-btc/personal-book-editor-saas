/**
 * `npm run generate-secret -- <NAME>`
 *
 * Prints one secret so an operator can paste it into a deployment's environment
 * store. Values are written to stdout on purpose and printed nowhere else: no
 * log line, no file, no observation field may ever carry them.
 *
 *   npm run generate-secret -- BETTER_AUTH_SECRET
 *   npm run generate-secret              # names and lengths only
 *   npm run generate-secret -- --json    # every secret as JSON, for a secret store
 */
import { generateSecret, secretNames, secretSpecs } from './lib/secrets.mjs';

const argv = process.argv.slice(2);
const known = new Set(secretNames);
const named = argv.filter((value) => !value.startsWith('-'));

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node scripts/generate-secret.mjs [NAME] [--json]');
  console.log(`Known secrets: ${secretNames.join(', ')}`);
  process.exit(0);
}

for (const name of named) {
  if (!known.has(name)) {
    console.error(`Unknown secret: ${name}`);
    console.error(`Known secrets: ${secretNames.join(', ')}`);
    process.exit(1);
  }
}

if (argv.includes('--json')) {
  const output = Object.fromEntries(secretNames.map((name) => [name, generateSecret(name)]));
  console.log(JSON.stringify(output, null, 2));
} else if (named.length) {
  for (const name of named) console.log(generateSecret(name));
} else {
  console.log('Available secrets (rerun with a name to print a value):');
  for (const name of secretNames) {
    const spec = secretSpecs[name];
    console.log(`  ${name}`);
    console.log(`    ${spec.bytes} bytes, ${spec.encoding}, at least ${spec.minimumLength} characters`);
    console.log(`    used for: ${spec.purpose}`);
  }
}
