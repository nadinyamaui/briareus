// @ts-check
import { decryptDatabaseBackup } from '../lib/database-backups.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnvFile, ROOT } from '../lib/config.js';

const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error('Usage: node scripts/decrypt-database-backup.js backup.gz.enc database.gz');
const secret =
  process.env.CREDENTIALS_KEY ||
  parseEnvFile(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')).CREDENTIALS_KEY;
await decryptDatabaseBackup(input, output, secret);
console.log(`Decrypted and authenticated: ${output}`);
