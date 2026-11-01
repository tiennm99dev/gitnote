import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Port of the local git server the unit tests use. */
export const GIT_SERVER_PORT = 8175;

/** Port of the relay the unit tests use. */
export const RELAY_PORT = 8788;

/** Environment variable that carries the bare repo root to test workers. */
export const GIT_ROOT_ENV = 'GITNOTE_TEST_GIT_ROOT';

/** Native git settings that make tests independent of the machine's git config. */
const GIT_CONFIG = [
	'-c', 'user.name=Remote Author',
	'-c', 'user.email=remote@example.com',
	'-c', 'init.defaultBranch=main',
	'-c', 'commit.gpgsign=false',
	'-c', 'core.hooksPath=/dev/null'
];

let nextRepo = 1;

/**
 * Runs native git, the independent witness of what the engine really did.
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {Promise<string>} stdout
 */
export function runGit(args, cwd) {
	return new Promise((resolve, reject) => {
		execFile(
			'git',
			[...GIT_CONFIG, ...args],
			{ cwd, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } },
			(error, stdout, stderr) => {
				if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
				else resolve(stdout);
			}
		);
	});
}

/**
 * @template T
 * @param {string} bare path of the bare repo
 * @param {(work: string) => Promise<T>} callback gets a fresh native clone
 * @returns {Promise<T>}
 */
async function withNativeClone(bare, callback) {
	const work = await mkdtemp(path.join(tmpdir(), 'gitnote-work-'));
	try {
		await runGit(['clone', '--quiet', bare, work]);
		return await callback(work);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

/**
 * @param {string} work
 * @param {Record<string, string | Uint8Array>} files
 * @param {string} message
 * @returns {Promise<void>}
 */
async function commitFiles(work, files, message) {
	for (const [name, content] of Object.entries(files)) {
		const target = path.join(work, name);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content);
	}
	await runGit(['add', '--all'], work);
	await runGit(['commit', '--quiet', '-m', message], work);
}

/**
 * @typedef {object} Remote
 * @property {string} bare path of the bare repo on disk
 * @property {string} url its URL on the local git server
 * @property {string} id a repo id unique to this repo
 */

/**
 * Creates a bare repo with one seed commit on `main`, or with no commit at all
 * when `files` is empty.
 * @param {Record<string, string | Uint8Array>} files
 * @param {{ root?: string, port?: number }} [options] default to the unit-test server
 * @returns {Promise<Remote>}
 */
export async function createRemote(files, { root = process.env[GIT_ROOT_ENV], port = GIT_SERVER_PORT } = {}) {
	if (!root) throw new Error(`${GIT_ROOT_ENV} is not set; the git fixture setup did not run`);
	const name = `repo-${process.pid}-${nextRepo++}`;
	const bare = path.join(root, 'owner', `${name}.git`);
	await mkdir(bare, { recursive: true });
	await runGit(['init', '--quiet', '--bare', bare]);
	await runGit(['config', 'http.receivepack', 'true'], bare);
	if (Object.keys(files).length > 0) {
		await withNativeClone(bare, async (work) => {
			await commitFiles(work, files, 'seed');
			await runGit(['push', '--quiet', 'origin', 'HEAD:main'], work);
		});
	}
	return { bare, url: `http://localhost:${port}/owner/${name}.git`, id: `localhost/owner/${name}` };
}

/**
 * Adds one commit to `main` of the bare repo, as another device would.
 * @param {Remote} remote
 * @param {Record<string, string | Uint8Array>} files
 * @param {string} message
 * @returns {Promise<void>}
 */
export async function pushFromElsewhere(remote, files, message) {
	await withNativeClone(remote.bare, async (work) => {
		await commitFiles(work, files, message);
		await runGit(['push', '--quiet', 'origin', 'HEAD:main'], work);
	});
}

/**
 * Like `pushFromElsewhere`, with a callback for changes other than writing
 * files, such as a delete or a symbolic link.
 * @param {Remote} remote
 * @param {Record<string, string | Uint8Array>} files
 * @param {(work: string) => Promise<void>} [change] runs in the fresh clone before the commit
 * @returns {Promise<void>}
 */
export async function changeElsewhere(remote, files, change) {
	await withNativeClone(remote.bare, async (work) => {
		await change?.(work);
		await commitFiles(work, files, 'remote change');
		await runGit(['push', '--quiet', 'origin', 'HEAD:main'], work);
	});
}

/**
 * @param {string | Uint8Array} content
 * @returns {string} the blob id git gives this content
 */
export function nativeBlobHash(content) {
	const bytes = Buffer.from(content);
	return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * Makes the bare repo refuse every push the way a host's pre-receive check does.
 * @param {Remote} remote
 * @param {string} message what the host says over sideband before refusing
 * @returns {Promise<void>}
 */
export async function rejectPushes(remote, message) {
	const hook = path.join(remote.bare, 'hooks', 'pre-receive');
	await mkdir(path.dirname(hook), { recursive: true });
	await writeFile(hook, `#!/bin/sh\necho ${JSON.stringify(message)} >&2\nexit 1\n`, { mode: 0o755 });
}

/**
 * @param {Remote} remote
 * @param {string} revision e.g. `main:notes/a.md`
 * @returns {Promise<string>}
 */
export function showRemote(remote, revision) {
	return runGit(['show', revision], remote.bare);
}

/**
 * @param {Remote} remote
 * @returns {Promise<string>} the oid of `main`
 */
export async function remoteHead(remote) {
	return (await runGit(['rev-parse', 'main'], remote.bare)).trim();
}
