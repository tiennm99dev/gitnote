/**
 * Builds the app for the Capacitor WebView, on any OS: `node scripts/build-native.js
 * [dir]`. The output directory defaults to the one in `capacitor.config.json`, and
 * its Content Security Policy allows the bridge's inline script, so never deploy it
 * to the web. See `csp` in `vite.config.js`.
 */

import { createBuilder } from 'vite';

process.env.CAP_BUILD = '1';
if (process.argv[2]) process.env.GITNOTE_BUILD_DIR = process.argv[2];
const builder = await createBuilder();
await builder.buildApp();
