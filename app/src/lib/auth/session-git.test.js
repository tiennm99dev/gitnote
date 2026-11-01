import { memfs } from 'memfs';
import { describe, expect, it, vi } from 'vitest';
import { fetchDouble, jsonResponse, memoryStorage, memoryTokenStore } from '../../../test/auth-doubles.js';
import { FIXTURE_CREDENTIAL } from '../../../test/git-http-server.js';
import { createRemote, GIT_SERVER_PORT, RELAY_PORT, showRemote } from '../../../test/remote-repo.js';
import { ErrorCode } from '../git/errors.js';
import { createGitHttp } from '../git/http.js';
import { createRepo } from '../git/repo.js';
import { createGithubAdapter } from './github.js';
import { createGitlabAdapter } from './gitlab.js';
import { createAuthSession } from './session.js';

const AUTHOR = { name: 'Local Author', email: 'local@example.com' };
const RELAY_ORIGIN = `http://127.0.0.1:${RELAY_PORT}`;
const USER = { login: 'octo', name: null, email: null };

/**
 * A real push through the real relay to a real git server. The clone URL says
 * github.com, as in the app, and only the last hop goes to the local server, so
 * the session's host check runs on the real URL.
 * @param {import('../../../test/remote-repo.js').Remote} remote
 * @param {import('isomorphic-git').HttpClient} relayHttp
 * @returns {{ url: string, http: import('isomorphic-git').HttpClient }}
 */
function asGithub(remote, relayHttp) {
	const path = new URL(remote.url).pathname;
	const url = `https://github.com${path}`;
	return {
		url,
		http: {
			request: (request) => relayHttp.request({ ...request, url: request.url.replace('https://github.com', `http://localhost:${GIT_SERVER_PORT}`) })
		}
	};
}

/**
 * @param {typeof fetch} fetch
 * @param {import('./session.js').Credential} stored
 * @returns {Promise<ReturnType<typeof createAuthSession>>}
 */
async function sessionWith(fetch, stored) {
	/** @type {import('./token-store.js').TokenStore<import('./session.js').Credential>} */
	const store = memoryTokenStore();
	await store.set('github', stored);
	return createAuthSession({
		store,
		adapters: { github: createGithubAdapter({ clientId: 'id', relayOrigin: 'https://relay.example.com', fetch }), gitlab: createGitlabAdapter({ clientId: 'id', fetch }) },
		pendingStorage: memoryStorage(),
		fetch
	});
}

describe('a push with a token the host has stopped accepting', () => {
	it('refreshes once mid-push and lands', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const fetch = fetchDouble(() => jsonResponse({ access_token: FIXTURE_CREDENTIAL.password, refresh_token: 'next-refresh', expires_in: 28800 }));
		const session = await sessionWith(fetch, { kind: 'oauth', accessToken: 'revoked', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000, user: USER });
		const { url, http } = asGithub(remote, createGitHttp({ relayOrigin: RELAY_ORIGIN }));
		const repo = createRepo({ id: remote.id, fs: /** @type {never} */ (memfs().fs), http, provider: 'github', getCredential: session.gitCredentials('github'), storage: {} });
		await repo.clone({ url });
		await repo.writeFile('note.md', 'pushed\n');
		await repo.commit({ paths: ['note.md'], message: 'note', author: AUTHOR });

		expect((await repo.push()).pushed).toBe(true);

		expect(await showRemote(remote, 'main:note.md')).toBe('pushed\n');
		expect(fetch.calls).toHaveLength(1);
		expect(JSON.parse(String(fetch.calls[0].init.body))).toEqual({ refresh_token: 'refresh' });
	});

	it('keeps the commit and asks for a sign-in when the refresh is refused', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const fetch = fetchDouble(() => jsonResponse({ error: 'bad_refresh_token', message: 'refused' }, 400));
		const session = await sessionWith(fetch, { kind: 'oauth', accessToken: 'revoked', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000, user: USER });
		const { url, http } = asGithub(remote, createGitHttp({ relayOrigin: RELAY_ORIGIN }));
		const repo = createRepo({ id: remote.id, fs: /** @type {never} */ (memfs().fs), http, provider: 'github', getCredential: session.gitCredentials('github'), storage: {} });
		await repo.clone({ url });
		await repo.writeFile('note.md', 'kept\n');
		await repo.commit({ paths: ['note.md'], message: 'note', author: AUTHOR });
		const warn = vi.spyOn(console, 'error');

		await expect(repo.push()).rejects.toMatchObject({ code: ErrorCode.AUTH_REQUIRED });

		expect((await repo.aheadBehind()).ahead).toBe(1);
		expect(await repo.readText('note.md')).toBe('kept\n');
		expect((await session.listAccounts())[0].needsSignIn).toBe(true);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
