import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import { parse } from 'yaml';
import { LIVE_ORIGIN, originFromWranglerConfig } from './live-origin.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * @typedef {object} Step
 * @property {string} [name]
 * @property {string} [id]
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
 * @property {Record<string, string>} [outputs]
 * @property {Step[]} steps
 */

const workflow = /** @type {{ env?: Record<string, string>, permissions: Record<string, string>, jobs: Record<string, Job> }} */ (parse(await readFile(path.join(ROOT, '.github/workflows/android.yml'), 'utf8')));

const deploy = /** @type {{ env?: Record<string, string>, on: Record<string, unknown>, permissions: Record<string, string>, jobs: Record<string, Job & { if?: string }> }} */ (parse(await readFile(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8')));

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

	it('starts from CI on main or by hand', () => {
		expect(Object.keys(deploy.on).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
		expect(deploy.on.workflow_run).toMatchObject({ workflows: ['CI'], types: ['completed'], branches: ['main'] });
	});

	describe('its gate', () => {
		const condition = String(deploy.jobs['check-tip'].if);
		// A fork names itself here, so the cases must not pin one repository's name.
		const repository = String(/github\.repository == '([^']+)'/.exec(condition)?.[1]);
		const fork = 'someone/gitnote';
		const passedPush = { conclusion: 'success', event: 'push', head_repository: { full_name: repository } };

		/**
		 * Runs the condition itself. It uses only `==`, `&&`, `||`, brackets, strings and
		 * context names, which mean the same in JavaScript; anything else throws here. A
		 * missing property is an empty value in both, one level below `workflow_run`.
		 * @param {Record<string, unknown>} github
		 * @returns {boolean} whether GitHub would start the job
		 */
		const gate = (github) => new Function('github', `return ${condition.replaceAll('==', '===')};`)({ repository, ref: 'refs/heads/main', event_name: 'workflow_run', event: { workflow_run: {} }, ...github });

		it.each([
			['a push CI passed', { event: { workflow_run: passedPush } }, true],
			['a push whose CI failed', { event: { workflow_run: { ...passedPush, conclusion: 'failure' } } }, false],
			['a push whose CI was cancelled', { event: { workflow_run: { ...passedPush, conclusion: 'cancelled' } } }, false],
			['CI started by hand', { event: { workflow_run: { ...passedPush, event: 'workflow_dispatch' } } }, false],
			// The branch filter alone also matches a fork's pull request from its `main`.
			['a pull request from a fork', { event: { workflow_run: { ...passedPush, event: 'pull_request', head_repository: { full_name: fork } } } }, false],
			['a pull request from this repository', { event: { workflow_run: { ...passedPush, event: 'pull_request' } } }, false],
			['a passed push from another repository', { event: { workflow_run: { ...passedPush, head_repository: { full_name: fork } } } }, false],
			['a passed push in a copy of this repository', { repository: fork, event: { workflow_run: passedPush } }, false],
			['a start by hand on main', { event_name: 'workflow_dispatch' }, true],
			['a start by hand on another branch', { event_name: 'workflow_dispatch', ref: 'refs/heads/other' }, false],
			['a start by hand in a copy of this repository', { event_name: 'workflow_dispatch', repository: fork }, false]
		])('for %s', (_name, github, expected) => {
			expect(gate(github)).toBe(expected);
		});
	});

	describe('a commit main has moved past', () => {
		const sha = 'a'.repeat(40);
		const newer = 'b'.repeat(40);
		const compare = deploy.jobs['check-tip'].steps[0];
		/** @type {string | undefined} */
		let dir;

		afterEach(async () => {
			if (dir) await rm(dir, { recursive: true });
			dir = undefined;
		});

		/**
		 * Runs the step's own script the way GitHub does, with GitHub's API answering
		 * through a `gh` on the path.
		 * @param {string} ghScript
		 * @returns {Promise<{ code: number, output: string, stdout: string }>} its exit code, what it wrote to GITHUB_OUTPUT and to stdout
		 */
		async function runCompare(ghScript) {
			dir = await mkdtemp(path.join(os.tmpdir(), 'gitnote-check-tip-'));
			const gh = path.join(dir, 'gh');
			const outputFile = path.join(dir, 'output');
			await writeFile(gh, `#!/bin/sh\n${ghScript}\n`);
			await chmod(gh, 0o755);
			await writeFile(outputFile, '');
			const env = { PATH: `${dir}:${process.env.PATH}`, COMMIT: sha, GITHUB_OUTPUT: outputFile, GITHUB_REPOSITORY: 'owner/repo' };
			const result = await promisify(execFile)('bash', ['-e', '-c', String(compare.run)], { env }).then(
				({ stdout }) => ({ code: 0, stdout }),
				(error) => ({ code: Number(error.code), stdout: String(error.stdout) })
			);
			return { ...result, output: (await readFile(outputFile, 'utf8')).trim() };
		}

		it('publishes the tip', async () => {
			const { code, output } = await runCompare(`echo ${sha}`);
			expect(code).toBe(0);
			expect(output).toBe('is-tip=true');
		});

		it('skips an older commit and says why', async () => {
			const { code, output, stdout } = await runCompare(`echo ${newer}`);
			expect(code).toBe(0);
			expect(output).toBe('is-tip=false');
			expect(stdout).toContain(`::notice::Not publishing ${sha}, because main has moved on to ${newer}`);
		});

		it('publishes nothing when it cannot read main', async () => {
			const failed = await runCompare('exit 1');
			expect(failed.code).not.toBe(0);
			expect(failed.output).toBe('');
			await rm(String(dir), { recursive: true });
			const empty = await runCompare('exit 0');
			expect(empty.code).not.toBe(0);
			expect(empty.output).toBe('');
		});

		it('asks about main and compares the commit this run would publish', () => {
			expect(compare.run).toContain('repos/$GITHUB_REPOSITORY/git/ref/heads/main');
			expect(compare.env?.COMMIT).toBe(deploy.jobs.deploy.steps[0].with?.ref);
		});

		it('takes both the deploy and the live tests with it', () => {
			expect(deploy.jobs['check-tip'].outputs?.['is-tip']).toBe('${{ steps.compare.outputs.is-tip }}');
			expect(compare.id).toBe('compare');
			expect(deploy.jobs.deploy.needs).toBe('check-tip');
			expect(deploy.jobs.deploy.if).toBe("needs.check-tip.outputs.is-tip == 'true'");
			// A job is skipped along with one it needs, unless its own `if` overrides that.
			expect(deploy.jobs['live-e2e'].needs).toBe('deploy');
			expect(deploy.jobs['live-e2e'].if).toBeUndefined();
		});
	});

	it('keeps a CI run started by hand from cancelling the run of a push', async () => {
		const ci = /** @type {{ concurrency: { group: string, 'cancel-in-progress': boolean } }} */ (parse(await readFile(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')));
		expect(ci.concurrency.group).toBe('ci-${{ github.event_name }}-${{ github.ref }}');
		expect(ci.concurrency['cancel-in-progress']).toBe(true);
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
		expect(stepsWith('GITNOTE_E2E_TOKEN').map((step) => step.name)).toEqual(['Test a note round trip on the live site']);
		// A secret set higher up would reach every step, `npm ci` and the build included.
		expect(JSON.stringify(deploy.env ?? {})).not.toContain('secrets.');
		for (const [name, job] of Object.entries(deploy.jobs)) expect(JSON.stringify(job.env ?? {}), `${name} env`).not.toContain('secrets.');
		// GitHub rejects secret names that start with GITHUB_.
		expect(JSON.stringify(deploy)).not.toContain('secrets.GITHUB_');
	});

	it('says which setting is missing instead of leaving it to wrangler', () => {
		const step = allSteps.find((candidate) => candidate.name === 'Deploy the Worker');
		for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) expect(step?.run).toContain(`::error::The ${name}`);
	});

	it('warns before it builds a site with no sign-in buttons', () => {
		const names = deploy.jobs.deploy.steps.map((step) => step.name);
		expect(names).toContain('Warn about missing sign-in IDs');
		expect(names.indexOf('Warn about missing sign-in IDs')).toBeLessThan(names.indexOf('Build the web app'));
	});

	it('smoke tests every deploy with no credentials, whether or not a test repo exists', () => {
		const live = deploy.jobs['live-e2e'];
		expect(live.if).toBeUndefined();
		const smoke = live.steps.find((step) => step.name === 'Smoke test the live site');
		expect(smoke?.run).toContain('smoke.live.js');
		expect(smoke).not.toHaveProperty('if');
		expect(JSON.stringify(smoke)).not.toContain('secrets.');
		const roundTrip = live.steps.find((step) => step.name === 'Test a note round trip on the live site');
		expect(roundTrip?.run).toContain('notes.live.js');
		expect(roundTrip).toHaveProperty('if', "vars.GITNOTE_E2E_REPO != ''");
	});

	it('never publishes what a run with a token recorded', () => {
		expect(deploy.jobs['live-e2e'].steps.filter((step) => step.uses?.includes('upload-artifact'))).toEqual([]);
	});
});

describe('the deployed Worker configuration', () => {
	const config = unstable_readConfig({ config: path.join(ROOT, 'relay/wrangler.jsonc') });

	it('serves from its workers.dev hostname alone', () => {
		expect(new URL(LIVE_ORIGIN).hostname).toMatch(new RegExp(`^${config.name}\\.[^.]+\\.workers\\.dev$`));
		expect(config.routes ?? []).toEqual([]);
		expect(config.workers_dev).toBe(true);
		expect(config.preview_urls).toBe(false);
	});

	it('is the only place code names the deployment, so a fork changes one line', async () => {
		const { host } = new URL(LIVE_ORIGIN);
		const matches = await promisify(execFile)('git', ['grep', '-l', '-F', host, '--', 'app', 'relay/src', '.github', 'package.json'], { cwd: ROOT }).then(
			({ stdout }) => stdout,
			(error) => {
				// git grep exits with 1 when nothing matches.
				if (error.code === 1) return '';
				throw error;
			}
		);
		expect(matches).toBe('');
	});

	describe('the live tests', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
			vi.resetModules();
		});

		/**
		 * @param {string | undefined} url
		 * @returns {Promise<string | undefined>} the address the config sends them to
		 */
		async function baseURLWith(url) {
			vi.stubEnv('GITNOTE_LIVE_URL', url);
			vi.resetModules();
			const { default: config } = await import('../playwright.live.config.js');
			return config.use?.baseURL;
		}

		it('go to this deployment by default', async () => {
			expect(await baseURLWith(undefined)).toBe(config.vars.APP_ORIGIN);
		});

		it('go where they are told', async () => {
			expect(await baseURLWith('https://notes.example.com')).toBe('https://notes.example.com');
		});
	});

	it('refuses to guess a deployment when the configuration names none', () => {
		expect(originFromWranglerConfig('"APP_ORIGIN": "https://notes.example.com"')).toBe('https://notes.example.com');
		expect(() => originFromWranglerConfig('"vars": {}')).toThrow('no APP_ORIGIN');
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
