import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Port of the plain static server the browser tests load the built shell from. */
export const STATIC_SHELL_PORT = 4174;

/** Where the browser tests build to, under `app/`. It is never deployed. */
export const E2E_BUILD_DIR = 'build-e2e';

const BUILD_DIR = fileURLToPath(new URL(`../${E2E_BUILD_DIR}/`, import.meta.url));

/** @type {Record<string, string>} */
export const CONTENT_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.txt': 'text/plain; charset=utf-8',
	'.webmanifest': 'application/manifest+json'
};

/**
 * Serves the built app the way the Capacitor WebView and Static Assets see
 * it: the files exactly as built, unknown paths answered with `index.html`
 * for the client router, and no Content-Security-Policy header, so only the
 * policy inside the built shell applies. Files are read per request, so the
 * server may start before the build finishes; until `index.html` exists it
 * answers 404.
 * @param {number} port
 * @returns {import('node:http').Server}
 */
export function startStaticServer(port) {
	const server = createServer((request, response) => {
		serve(request.url ?? '/').then(
			({ status, type, body }) => {
				response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
				response.end(body);
			},
			() => {
				response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
				response.end('static server error');
			}
		);
	});
	server.listen(port, '127.0.0.1');
	return server;
}

/**
 * @param {string} requestUrl
 * @returns {Promise<{ status: number, type: string, body: Buffer | string }>}
 */
async function serve(requestUrl) {
	const pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
	const file = resolve(BUILD_DIR, `.${pathname}`);
	if (file.startsWith(BUILD_DIR) || `${file}${sep}` === BUILD_DIR) {
		const asset = await readIfFile(file);
		if (asset !== null) {
			return { status: 200, type: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', body: asset };
		}
	}
	const shell = await readIfFile(resolve(BUILD_DIR, 'index.html'));
	if (shell === null) return { status: 404, type: 'text/plain; charset=utf-8', body: 'not built yet' };
	return { status: 200, type: CONTENT_TYPES['.html'], body: shell };
}

/**
 * @param {string} file
 * @returns {Promise<Buffer | null>} null when the path is missing or not a file
 */
async function readIfFile(file) {
	try {
		return await readFile(file);
	} catch (error) {
		const code = /** @type {NodeJS.ErrnoException} */ (error).code;
		if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null;
		throw error;
	}
}

if (import.meta.main) startStaticServer(STATIC_SHELL_PORT);
