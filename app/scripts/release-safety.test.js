import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * @typedef {object} Step
 * @property {string} [name]
 * @property {string} [uses]
 * @property {string} [run]
 * @property {Record<string, string>} [env]
 * @property {Record<string, unknown>} [with]
 */

/**
 * @typedef {object} Job
 * @property {Record<string, string>} [permissions]
 * @property {Record<string, string>} [env]
 * @property {string | string[]} [needs]
 * @property {Step[]} steps
 */

const workflow = /** @type {{ env?: Record<string, string>, permissions: Record<string, string>, jobs: Record<string, Job> }} */ (parse(await readFile(path.join(ROOT, '.github/workflows/android.yml'), 'utf8')));

describe('the Android workflow keeps the signing key from repository code', () => {
	const signing = workflow.jobs['sign-release'];

	it('names the secrets only in the steps of the signing job that run its own commands', () => {
		expect(JSON.stringify(workflow.env ?? {})).not.toContain('secrets.');
		for (const [name, job] of Object.entries(workflow.jobs)) {
			expect(JSON.stringify(job.env ?? {}), `${name} env`).not.toContain('secrets.');
			if (job !== signing) expect(JSON.stringify(job), name).not.toContain('secrets.');
		}
		for (const step of signing.steps) {
			if (step.uses) expect(JSON.stringify(step), step.name).not.toContain('secrets.');
		}
	});

	it('runs no repository or npm code in the signing job', () => {
		for (const step of signing.steps) {
			expect(step.uses ?? '', step.name).not.toMatch(/^\.\/|checkout/);
			expect(step.run ?? '', step.name).not.toMatch(/\b(npm|npx|node|gradlew|cap)\b/);
		}
	});

	it('signs only what the build job handed over', () => {
		expect(signing.needs).toBe('build-release');
		expect(signing.steps.some((step) => step.uses?.startsWith('actions/download-artifact@'))).toBe(true);
	});

	it('gives write access to the signing job alone', () => {
		expect(workflow.permissions).toEqual({ contents: 'read' });
		for (const [name, job] of Object.entries(workflow.jobs)) {
			if (job !== signing) expect(job.permissions?.contents, name).not.toBe('write');
		}
		expect(signing.permissions).toEqual({ contents: 'write' });
	});

	it('leaves no token in the checkout that runs npm and Gradle', () => {
		const checkouts = Object.values(workflow.jobs).flatMap((job) => job.steps.filter((step) => step.uses?.startsWith('actions/checkout@')));
		expect(checkouts.length).toBeGreaterThan(0);
		for (const checkout of checkouts) expect(checkout.with?.['persist-credentials']).toBe(false);
	});
});

it.each(['gitnote-release.jks', 'android/gitnote-release.jks', 'android/app/release.keystore'])('git ignores a keystore at %s', async (file) => {
	// Exits with an error, and so rejects, when the path is not ignored.
	const { stdout } = await promisify(execFile)('git', ['check-ignore', file], { cwd: ROOT });
	expect(stdout.trim()).toBe(file);
});

describe('the Android WebView floor', () => {
	it('sends a WebView too old for the app to a page that says so, which ships in the build', async () => {
		const config = JSON.parse(await readFile(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
		// URL.canParse, used on every sign-in return, arrived in Chromium 120.
		expect(config.android.minWebViewVersion).toBeGreaterThanOrEqual(120);
		const page = await readFile(path.join(ROOT, 'app/static', config.server.errorPath), 'utf8');
		expect(page).toContain('Android System WebView');
	});
});
