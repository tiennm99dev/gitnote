import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

/**
 * The credential the local git server accepts. A fixture value for a server
 * that only ever holds throwaway test repos, not a secret.
 */
export const FIXTURE_CREDENTIAL = Object.freeze({ username: 'x-access-token', password: 'fixture-token' });

const AUTH_HEADER = `Basic ${Buffer.from(`${FIXTURE_CREDENTIAL.username}:${FIXTURE_CREDENTIAL.password}`).toString('base64')}`;

const HEADER_END = Buffer.from('\r\n\r\n');

/**
 * A real git host for tests: a small CGI wrapper around `git http-backend`,
 * serving the bare repos under `root`. Reads are public and writes need
 * {@link FIXTURE_CREDENTIAL}, like a public repository on a real host.
 * @param {{ port: number, root: string }} options
 * @returns {Promise<() => Promise<void>>} stops the server
 */
export async function startGitHttpServer({ port, root }) {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		const isWrite = url.pathname.endsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack';
		if (isWrite && request.headers.authorization !== AUTH_HEADER) {
			request.resume();
			response.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic realm="fixture"' });
			response.end('authentication required');
			return;
		}

		const backend = spawn('git', ['http-backend'], {
			stdio: ['pipe', 'pipe', 'ignore'],
			env: {
				PATH: process.env.PATH,
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: '1',
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				REQUEST_METHOD: request.method,
				REMOTE_USER: isWrite ? FIXTURE_CREDENTIAL.username : '',
				CONTENT_TYPE: request.headers['content-type'] ?? '',
				...(request.headers['content-length'] ? { CONTENT_LENGTH: request.headers['content-length'] } : {}),
				...(request.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: request.headers['content-encoding'] } : {}),
				...(request.headers['git-protocol'] ? { GIT_PROTOCOL: String(request.headers['git-protocol']) } : {})
			}
		});
		const fail = () => {
			if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' });
			response.end();
		};
		backend.on('error', fail);
		backend.stdin.on('error', () => {});
		request.pipe(backend.stdin);

		let head = Buffer.alloc(0);
		let headerDone = false;
		backend.stdout.on('data', (/** @type {Buffer} */ chunk) => {
			if (headerDone) {
				response.write(chunk);
				return;
			}
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf(HEADER_END);
			if (end === -1) return;
			headerDone = true;
			const { status, headers } = parseCgiHead(head.subarray(0, end).toString('latin1'));
			response.writeHead(status, headers);
			response.write(head.subarray(end + HEADER_END.length));
		});
		backend.stdout.on('end', () => {
			if (headerDone) response.end();
			else fail();
		});
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, () => resolve(undefined));
	});

	return async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(() => resolve(undefined)));
	};
}

/**
 * @param {string} text the CGI header block
 * @returns {{ status: number, headers: Record<string, string> }}
 */
function parseCgiHead(text) {
	let status = 200;
	/** @type {Record<string, string>} */
	const headers = {};
	for (const line of text.split('\r\n')) {
		const colon = line.indexOf(':');
		if (colon === -1) continue;
		const name = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
		else headers[name] = value;
	}
	return { status, headers };
}
