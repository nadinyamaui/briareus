// Writes docs/api-v1-reference.md from the client API's catalog
// (lib/api-v1-catalog.js). Run it after changing a route: `npm run
// build:api-docs`. test/api-v1.test.js fails while the file on disk is not
// what this would write.
import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';
import { apiV1Reference } from '../lib/api-v1-docs.js';

const file = path.join(import.meta.dirname, '..', 'docs', 'api-v1-reference.md');
const options = await prettier.resolveConfig(file);
fs.writeFileSync(file, await prettier.format(apiV1Reference(), { ...options, filepath: file }));
console.log(`Wrote ${path.relative(process.cwd(), file)}`);
