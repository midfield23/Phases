// Loads the SDK from your clone (built by its `npm install`), so this project needs no install.
// Default: ~/luna-builder-sdk. Elsewhere: LUNA_SDK=/path/to/luna-builder-sdk node tools/...
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sdk = process.env.LUNA_SDK ?? join(homedir(), 'luna-builder-sdk');
let mod;
try {
  mod = await import(pathToFileURL(join(sdk, 'dist', 'index.js')).href);
} catch (e) {
  console.error(`Could not load the LUNA SDK from ${sdk}/dist. Set LUNA_SDK to your clone.`);
  throw e;
}
export const { Luna } = mod;
