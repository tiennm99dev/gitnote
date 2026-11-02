import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { deployProblem } from '../../scripts/check-deployable-build.js';
import { collectBreakage } from '../provider-fixtures.js';

/** A public repo, so these tests need no credentials. */
const PUBLIC_REPO = 'github.com/tiennm99dev/gitnote.git';

// A deep link's last segment can look like a file: only the fallback to index.html
// keeps these from being a 404 on reload.
const REPO_LINKS = ['/repo/github.com%2Fowner%2Frepo/', '/repo/github.com%2Fowner%2Frepo/notes/a.md', '/repo/github.com%2Fowner%2Frepo/assets/a.png'];

test("the page carries the asset headers and a web build's CSP", async ({ request }) => {
	const response = await request.get('/');
	expect(response.status()).toBe(200);
	const headers = response.headers();
	expect(headers['referrer-policy']).toBe('no-referrer');
	expect(headers['x-content-type-options']).toBe('nosniff');
	expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
	expect(deployProblem(await response.text())).toBeNull();
});

/**
 * @param {string} link
 * @param {(page: import('@playwright/test').Page) => import('@playwright/test').Locator} rendered
 *   what only the mounted app shows: the static page holds nothing but its boot script,
 *   and a route that fails to load shows SvelteKit's error page instead
 */
function testDeepLink(link, rendered) {
	test(`a reload of ${link} boots the app under its CSP`, async ({ page }) => {
		const problems = collectBreakage(page);
		const response = await page.goto(link);
		expect(response?.status()).toBe(200);
		expect(response?.headers()['content-type']).toContain('text/html');
		await expect(rendered(page)).toBeVisible();
		await page.waitForLoadState('networkidle');
		expect(problems).toEqual([]);
	});
}

testDeepLink('/repos', (page) => page.getByRole('heading', { name: 'Repositories' }));
// A new browser has cloned nothing, so every repo link lands on the same notice.
for (const link of REPO_LINKS) testDeepLink(link, (page) => page.getByTestId('repo-not-here'));

test('the relay answers its own health check with API headers', async ({ request }) => {
	const response = await request.get('/api/health');
	expect(response.status()).toBe(200);
	expect(response.headers()['content-security-policy']).toContain("default-src 'none'");
});

test('the relay refuses hosts and paths outside its allowlist', async ({ request }) => {
	expect((await request.get('/api/git/example.com/owner/repo.git/info/refs?service=git-upload-pack')).status()).toBe(403);
	expect((await request.get('/api/git/github.com/tiennm99dev/gitnote/blob/main/README.md')).status()).toBe(403);
});

test('the relay answers the Android origin and refuses another site', async ({ request }) => {
	const url = `/api/git/${PUBLIC_REPO}/git-upload-pack`;
	const preflight = (/** @type {string} */ origin) =>
		request.fetch(url, {
			method: 'OPTIONS',
			headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,git-protocol' }
		});
	const android = await preflight('https://localhost');
	expect(android.ok()).toBe(true);
	expect(android.headers()['access-control-allow-origin']).toBe('https://localhost');
	expect((await preflight('https://example.com')).status()).toBe(403);
});

test('native git clones a public repo through the relay, and a push needs credentials', async ({ baseURL, request }) => {
	const dir = await mkdtemp(path.join(tmpdir(), 'gitnote-live-'));
	try {
		await promisify(execFile)('git', ['clone', '--quiet', '--depth', '1', `${baseURL}/api/git/${PUBLIC_REPO}`, dir], {
			env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
		});
		expect((await stat(path.join(dir, 'README.md'))).isFile()).toBe(true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	const push = await request.get(`/api/git/${PUBLIC_REPO}/info/refs?service=git-receive-pack`, { headers: { 'user-agent': 'git/2.0' } });
	expect(push.status()).toBe(401);
});
