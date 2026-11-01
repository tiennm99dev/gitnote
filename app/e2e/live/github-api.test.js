import { describe, expect, it } from 'vitest';
import { createGitHubApi } from './github-api.js';

/**
 * @param {Record<string, { status?: number, body?: unknown }[]>} script answers by `METHOD path`, used in order
 * @returns {{ fetchImpl: typeof fetch, calls: { key: string, body: unknown, authorization: string | null }[] }}
 */
function scripted(script) {
	/** @type {{ key: string, body: unknown, authorization: string | null }[]} */
	const calls = [];
	/** @type {typeof fetch} */
	const fetchImpl = async (url, init) => {
		const key = `${init?.method} ${String(url).replace('https://api.github.com/repos/o/r', '')}`;
		calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: new Headers(init?.headers).get('authorization') });
		const answer = script[key]?.shift();
		if (!answer) throw new Error(`Unexpected call: ${key}`);
		return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
	};
	return { fetchImpl, calls };
}

const repoAnswers = () => ({
	'GET ': [{ body: { default_branch: 'main' } }],
	'GET /git/ref/heads/main': [{ body: { object: { sha: 'abc' } } }]
});

describe('createGitHubApi', () => {
	it('force-moves an existing test branch to the tip of the default branch', async () => {
		const { fetchImpl, calls } = scripted({ ...repoAnswers(), 'PATCH /git/refs/heads/e2e': [{}] });
		expect(await createGitHubApi('o/r', 'tok', fetchImpl).resetBranch('e2e')).toBe('abc');
		expect(calls.at(-1)?.body).toEqual({ sha: 'abc', force: true });
		expect(calls.every((call) => call.authorization === 'Bearer tok')).toBe(true);
	});

	it('creates the test branch when GitHub says it does not exist', async () => {
		const { fetchImpl, calls } = scripted({ ...repoAnswers(), 'PATCH /git/refs/heads/e2e': [{ status: 422 }], 'POST /git/refs': [{ status: 201 }] });
		await createGitHubApi('o/r', 'tok', fetchImpl).resetBranch('e2e');
		expect(calls.at(-1)?.body).toEqual({ ref: 'refs/heads/e2e', sha: 'abc' });
	});

	it('never resets the default branch', async () => {
		const { fetchImpl, calls } = scripted(repoAnswers());
		await expect(createGitHubApi('o/r', 'tok', fetchImpl).resetBranch('main')).rejects.toThrow('must not be the default branch');
		expect(calls.map((call) => call.key)).toEqual(['GET ']);
	});

	it('reports a refusal by its status, without the token', async () => {
		const { fetchImpl } = scripted({ 'GET ': [{ status: 403 }] });
		const failure = await createGitHubApi('o/r', 'secret-token', fetchImpl).resetBranch('e2e').catch((error) => error.message);
		expect(failure).toContain('HTTP 403');
		expect(failure).not.toContain('secret-token');
	});

	it('decodes a file and encodes a new one', async () => {
		const { fetchImpl, calls } = scripted({
			'GET /contents/a%20b.md?ref=e2e': [{ body: { content: Buffer.from('héllo\n').toString('base64') } }],
			'PUT /contents/n.md': [{ status: 201 }]
		});
		const api = createGitHubApi('o/r', 'tok', fetchImpl);
		expect(await api.readText('a b.md', 'e2e')).toBe('héllo\n');
		await api.putText('n.md', 'e2e', 'hi', 'add');
		expect(calls.at(-1)?.body).toEqual({ branch: 'e2e', message: 'add', content: Buffer.from('hi').toString('base64') });
	});

	it('refuses a repo name that could leave the repo API', () => {
		expect(() => createGitHubApi('o/r/../../user', 'tok')).toThrow('owner/repo');
	});
});
