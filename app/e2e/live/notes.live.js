import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { E2E_TOKEN_ENV } from '../artifact-policy.js';
import { connectAndClone, editCommitPush, pullAndSee } from '../note-round-trip.js';
import { collectBreakage } from '../provider-fixtures.js';
import { createGitHubApi } from './github-api.js';

/** Reset before every run. Nothing else in the test repo ever changes. */
const BRANCH = 'gitnote-e2e';

const token = process.env[E2E_TOKEN_ENV]?.trim() ?? '';
const fullName = process.env.GITNOTE_E2E_REPO?.trim() ?? '';

test.skip(!token || !fullName, `Needs ${E2E_TOKEN_ENV} and GITNOTE_E2E_REPO; see docs/architecture.md.`);

test('a pasted token clones, edits, commits, pushes and pulls through the live relay', async ({ page }) => {
	const problems = collectBreakage(page);
	const api = createGitHubApi(fullName, token);
	const run = randomUUID();
	await api.resetBranch(BRANCH);

	await connectAndClone(page, { token, fullName, branch: BRANCH });
	const text = `Written by the live test, run ${run}.\n`;
	await editCommitPush(page, { fullName, branch: BRANCH, note: 'README.md', text, readRemote: () => api.readText('README.md', BRANCH) });

	const fileName = `from-elsewhere-${run}.md`;
	await api.putText(fileName, BRANCH, 'hello\n', 'Add a file from another device');
	await pullAndSee(page, fileName);
	expect(problems).toEqual([]);
});
