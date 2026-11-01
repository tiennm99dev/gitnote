import { expect, test } from '@playwright/test';
import { createRemote, pushFromElsewhere, showRemote } from '../test/remote-repo.js';
import { E2E_GIT_PORT, E2E_GIT_ROOT } from './git-engine-ports.js';
import { connectAndClone, editCommitPush, pullAndSee } from './note-round-trip.js';
import { collectBreakage, GOOD_TOKEN, serveApi, serveGit } from './provider-fixtures.js';

test.describe.configure({ timeout: 90_000 });

// The live test can only run with a real token, so its steps are held to the current
// UI here on every CI run.
test('the steps of the live test connect, clone, push and pull', async ({ page }) => {
	const problems = collectBreakage(page);
	const remote = await createRemote({ 'README.md': 'seed\n' }, { root: E2E_GIT_ROOT, port: E2E_GIT_PORT });
	const fullName = new URL(remote.url).pathname.slice(1).replace(/\.git$/, '');
	await serveApi(page, 'github', GOOD_TOKEN, {
		'/user/repos?per_page=100&sort=updated&page=1': [{ id: 41, full_name: fullName, default_branch: 'main', size: 12, private: true }],
		[`/repos/${fullName}/branches?per_page=100&page=1`]: [{ name: 'main' }]
	});
	await serveGit(page, 'github', GOOD_TOKEN);

	await connectAndClone(page, { token: GOOD_TOKEN, fullName, branch: 'main' });
	await editCommitPush(page, { fullName, branch: 'main', note: 'README.md', text: 'edited in the app\n', readRemote: () => showRemote(remote, 'main:README.md') });

	await pushFromElsewhere(remote, { 'from-elsewhere.md': 'hello\n' }, 'another device');
	await pullAndSee(page, 'from-elsewhere.md');
	expect(problems).toEqual([]);
});
