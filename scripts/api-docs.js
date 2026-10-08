// Writes docs/api-v1-reference.md from lib/api-v1-catalog.js; run `npm run
// build:api-docs` after changing a route. test/api-v1.test.js fails while the file is stale.
import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';
import { apiV1Reference } from '../lib/api-v1-docs.js';

const file = path.join(import.meta.dirname, '..', 'docs', 'api-v1-reference.md');
const options = await prettier.resolveConfig(file);
fs.writeFileSync(file, await prettier.format(apiV1Reference(), { ...options, filepath: file }));
console.log(`Wrote ${path.relative(process.cwd(), file)}`);
