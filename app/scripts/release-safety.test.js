import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';
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

const deploy = /** @type {{ on: Record<string, unknown>, permissions: Record<string, string>, jobs: Record<string, Job & { if?: string }> }} */ (parse(await readFile(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8')));

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

describe('the deploy workflow', () => {
	const allSteps = Object.values(deploy.jobs).flatMap((job) => job.steps);

	/**
	 * @param {string} secret
	 * @returns {Step[]} the steps that name it
	 */
	const stepsWith = (secret) => allSteps.filter((step) => JSON.stringify(step).includes(`secrets.${secret}`));

	it('runs only after CI on main or by hand, never for a pull request', () => {
		expect(Object.keys(deploy.on).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
		expect(deploy.on.workflow_run).toMatchObject({ workflows: ['CI'], types: ['completed'], branches: ['main'] });
		// The branch filter alone also matches a fork's pull request from its `main`.
		for (const check of ["workflow_run.conclusion == 'success'", "workflow_run.event == 'push'", 'head_repository.full_name == github.repository', "github.repository == 'tiennm99dev/gitnote'"]) {
			expect(deploy.jobs.deploy.if).toContain(check);
		}
		expect(deploy.jobs['live-e2e'].needs).toBe('deploy');
	});

	it('publishes the commit CI passed, not whatever main holds by then', () => {
		const checkouts = allSteps.filter((step) => step.uses?.startsWith('actions/checkout@'));
		expect(checkouts).toHaveLength(2);
		for (const checkout of checkouts) {
			expect(checkout.with?.ref).toBe('${{ github.event.workflow_run.head_sha || github.sha }}');
			expect(checkout.with?.['persist-credentials']).toBe(false);
		}
	});

	it('hands each secret to the one step that needs it, with a read-only token', () => {
		expect(deploy.permissions).toEqual({ contents: 'read' });
		for (const job of Object.values(deploy.jobs)) expect(job.permissions).toBeUndefined();
		expect(stepsWith('CLOUDFLARE_API_TOKEN').map((step) => step.name)).toEqual(['Deploy the Worker']);
		expect(stepsWith('GITNOTE_E2E_TOKEN').map((step) => step.name)).toEqual(['Test the live site']);
		// GitHub rejects secret names that start with GITHUB_.
		expect(JSON.stringify(deploy)).not.toContain('secrets.GITHUB_');
	});

	it('never publishes what a run with a token recorded', () => {
		expect(deploy.jobs['live-e2e'].steps.filter((step) => step.uses?.includes('upload-artifact'))).toEqual([]);
	});
});

describe('the deployed Worker configuration', () => {
	const config = unstable_readConfig({ config: path.join(ROOT, 'relay/wrangler.jsonc') });

	it('serves from the custom domain alone', () => {
		expect(config.routes).toEqual([{ pattern: 'gitnote.miti99.dev', custom_domain: true }]);
		expect(config.workers_dev).toBe(false);
		expect(config.preview_urls).toBe(false);
	});

	it('has no storage and keeps no logs', () => {
		expect(config.kv_namespaces).toEqual([]);
		expect(config.d1_databases).toEqual([]);
		expect(config.r2_buckets).toEqual([]);
		expect(config.durable_objects.bindings).toEqual([]);
		expect(config.tail_consumers ?? []).toEqual([]);
		expect(config.logpush).toBeFalsy();
		expect(config.observability?.enabled).toBe(false);
	});
});
