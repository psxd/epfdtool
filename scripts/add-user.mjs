#!/usr/bin/env node
// Adds (or overwrites) an account in netlify/functions/users.js.
//
//   npm run add-user -- alice "s3cret-pw" "Alice"
//   npm run add-user -- guest "guest" "Guest" --plain
//   npm run add-user -- alice "new-pw" "Alice" --force
//
// Passwords are stored salted + SHA-256 hashed by default (the salt is random
// per account). --plain writes the password as readable text instead, which
// means anyone who can read this public repo can use that account.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const USERS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'netlify', 'functions', 'users.js');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const [username, password, displayName = username] = positional;

const usage = `Usage: npm run add-user -- <username> "<password>" ["Display Name"] [--plain] [--force]

  --plain  store the password as readable text (visible to everyone reading the repo)
  --force  overwrite the account if the username already exists`;

function die(message) {
  console.error(message);
  console.error(`\n${usage}`);
  process.exit(1);
}

if (!username || !password) die('Need a username and a password.');
if (!/^[A-Za-z0-9._@-]+$/.test(username)) die(`Username "${username}" may only contain letters, digits and . _ @ -`);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keyRe = new RegExp(`^\\s*${escapeRe(username)}\\s*:`);
const lineFor = (salt) => {
  const name = JSON.stringify(String(displayName));
  if (flags.has('--plain')) {
    return `  ${username}: { name: ${name}, password: ${JSON.stringify(password)} }, // plain text — public`;
  }
  const digest = createHash('sha256').update(`${salt}:${password}`).digest('hex');
  return `  ${username}: { name: ${name}, hash: '${salt}:${digest}' },`;
};

const source = readFileSync(USERS_FILE, 'utf8');
const lines = source.split('\n');
const openIdx = lines.findIndex((l) => l.startsWith('export const USERS = {'));
const closeIdx = lines.findIndex((l, i) => i > openIdx && /^\}\s*;?\s*$/.test(l));
if (openIdx === -1 || closeIdx === -1) die(`Could not find the USERS map in ${USERS_FILE}`);

const existingIdx = lines.findIndex((l, i) => i > openIdx && i < closeIdx && keyRe.test(l));
const entryLine = lineFor(randomBytes(8).toString('hex'));
let summary;

if (existingIdx !== -1) {
  if (!flags.has('--force')) {
    console.log(`"${username}" already exists in netlify/functions/users.js — nothing changed.`);
    console.log('Re-run with --force to replace it, e.g.:');
    console.log(`  npm run add-user -- ${username} "<new password>" ${JSON.stringify(String(displayName))} --force`);
    process.exit(2);
  }
  lines[existingIdx] = entryLine;
  summary = `Replaced the "${username}" entry.`;
} else {
  lines.splice(closeIdx, 0, entryLine);
  summary = `Added "${username}" to netlify/functions/users.js.`;
}

writeFileSync(USERS_FILE, lines.join('\n'));
console.log(summary);
console.log(entryLine.trim());
console.log('\nNow publish it (functions only see the change after a deploy):');
console.log('  npx netlify deploy --prod');
