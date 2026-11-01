import { createServer } from 'node:http';

/**
 * A real git host stand-in for the relay tests, run by Vitest in Node before
 * the workerd tests start. It answers every POST `.../git-upload-pack` or
 * `.../git-receive-pack` once the whole body has arrived, and keeps a record
 * of each request body it saw, complete or cut off, so a test can check what
 * actually went over the wire instead of what a stubbed `fetch` was handed.
 *
 * `GET /__received?path=<repo path>` returns those records for one path.
 */
export const FIXTURE_PORT = 8174;

/**
 * @typedef {object} ReceivedBody
 * @property {string | null} contentLength the Content-Length header the host saw
 * @property {string | null} transferEncoding the Transfer-Encoding header the host saw
 * @property {number} bytes body bytes that arrived
 * @property {boolean} complete whether the body ended normally
 */

/**
 * Vitest global setup: starts the fixture and returns its teardown.
 * @returns {Promise<() => Promise<void>>}
 */
export default async function setup() {
	/** @type {Map<string, ReceivedBody[]>} */
	const received = new Map();

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		if (request.method === 'GET' && url.pathname === '/__received') {
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify(received.get(url.searchParams.get('path') ?? '') ?? []));
			return;
		}
		const service = /\/(git-upload-pack|git-receive-pack)$/.exec(url.pathname)?.[1];
		if (request.method !== 'POST' || service === undefined) {
			response.writeHead(404, { 'Content-Type': 'text/plain' });
			response.end('not found');
			return;
		}

		/** @type {ReceivedBody} */
		const record = {
			contentLength: request.headers['content-length'] ?? null,
			transferEncoding: request.headers['transfer-encoding'] ?? null,
			bytes: 0,
			complete: false
		};
		const path = url.pathname.slice(0, -service.length - 1);
		received.set(path, [...(received.get(path) ?? []), record]);

		request.on('data', (/** @type {Buffer} */ chunk) => {
			record.bytes += chunk.length;
		});
		request.on('end', () => {
			record.complete = true;
			response.writeHead(200, { 'Content-Type': `application/x-${service}-result` });
			response.end('0008NAK\n');
		});
		request.on('error', () => {});
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(FIXTURE_PORT, () => resolve(undefined));
	});

	return async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(() => resolve(undefined)));
	};
}
