import { expect } from '@playwright/test';
import { repoRouteId } from '../src/lib/git/repo-route.js';

/** @typedef {import('@playwright/test').Page} Page */

/**
 * @param {string} fullName `<owner>/<repo>` on github.com
 * @param {string} note its path in the repo
 * @returns {string} the app's address for that note
 */
const noteUrl = (fullName, note) => `/repo/${repoRouteId(`github.com/${fullName}`)}/${note.split('/').map(encodeURIComponent).join('/')}`;

/**
 * What a user does first: pastes a GitHub token, picks a repo and branch, and clones.
 * @param {Page} page
 * @param {{ token: string, fullName: string, branch: string }} options
 * @returns {Promise<void>}
 */
export async function connectAndClone(page, { token, fullName, branch }) {
	await page.goto('/connect');
	const github = page.getByTestId('account-github');
	await github.getByLabel('Or paste a token').fill(token);
	await github.getByRole('button', { name: 'Check and save' }).click();
	await expect(github.getByLabel('Or paste a token')).toHaveCount(0);
	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByTestId('repo-search').fill(fullName);
	await page.getByTestId('repo-option').click();
	await page.getByTestId('branch-select').selectOption(branch);
	await page.getByTestId('clone-button').click();
	await expect(page.getByTestId('open-copy')).toBeVisible({ timeout: 60_000 });
}

/**
 * Opens a note, replaces its text, then commits and pushes from the commit panel.
 * The unpushed count reads 0 before the commit as well as after the push, so only
 * the remote itself shows the push has happened.
 * @param {Page} page
 * @param {{ fullName: string, branch: string, note: string, text: string, readRemote: () => Promise<string> }} options
 * @returns {Promise<void>}
 */
export async function editCommitPush(page, { fullName, branch, note, text, readRemote }) {
	await page.goto(noteUrl(fullName, note));
	await expect(page.getByTestId('sync-branch')).toHaveText(branch);
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByTestId('note-editor').locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.type(text);
	await page.getByTestId('save-note').click();
	await expect(page.getByTestId('open-changes')).not.toHaveText('Changes (0)');
	await page.getByTestId('open-changes').click();
	await page.getByTestId('commit-push-button').click();
	await expect.poll(readRemote, { timeout: 60_000 }).toBe(text);
	await expect(page.getByTestId('sync-ahead')).toHaveText('0 unpushed commits');
	await expect(page.getByTestId('sync-report')).toHaveCount(0);
}

/**
 * Pulls and waits for a file another device added to appear in the tree.
 * @param {Page} page
 * @param {string} fileName
 * @returns {Promise<void>}
 */
export async function pullAndSee(page, fileName) {
	await page.getByTestId('pull-button').click();
	await expect(page.getByRole('link', { name: fileName })).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId('sync-behind')).toHaveText('0 behind');
}
