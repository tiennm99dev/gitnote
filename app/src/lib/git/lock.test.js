import { describe, expect, it } from 'vitest';
import { repoLockName, withRepoLock } from './lock.js';

/**
 * Runs two overlapping operations and records how they interleave.
 * @param {string} firstRepo
 * @param {string} secondRepo
 * @param {{ locks?: import('./lock.js').LockManagerLike | null }} [options]
 * @returns {Promise<string[]>}
 */
async function interleave(firstRepo, secondRepo, options) {
	/** @type {string[]} */
	const events = [];
	/**
	 * @param {string} name
	 * @returns {() => Promise<void>}
	 */
	const operation = (name) => async () => {
		events.push(`${name} start`);
		await new Promise((resolve) => setTimeout(resolve, 10));
		events.push(`${name} end`);
	};
	await Promise.all([withRepoLock(firstRepo, operation('a'), options), withRepoLock(secondRepo, operation('b'), options)]);
	return events;
}

describe.each([
	['navigator.locks', undefined],
	['the in-page fallback', { locks: null }]
])('withRepoLock with %s', (_name, options) => {
	it('runs operations on one repo one at a time', async () => {
		expect(await interleave('one', 'one', options)).toEqual(['a start', 'a end', 'b start', 'b end']);
	});

	it('lets different repos overlap', async () => {
		const events = await interleave('left', 'right', options);
		expect(events.slice(0, 2)).toEqual(['a start', 'b start']);
	});

	it('returns the result, and passes the lock on after a failure', async () => {
		const failed = withRepoLock(
			'failing',
			async () => {
				throw new Error('boom');
			},
			options
		);
		const next = withRepoLock('failing', async () => 'ok', options);
		await expect(failed).rejects.toThrow('boom');
		await expect(next).resolves.toBe('ok');
	});
});

describe('withRepoLock', () => {
	it('uses the Web Locks API by default, in exclusive mode', async () => {
		const names = await navigator.locks.request(repoLockName('held'), async () => {
			const state = await navigator.locks.query();
			return state.held?.map((lock) => `${lock.name}:${lock.mode}`);
		});
		expect(names).toContain('gitnote:repo:held:exclusive');

		/** @type {import('./lock.js').LockManagerLike} */
		const recording = {
			request: (name, requestOptions, callback) => {
				calls.push({ name, mode: requestOptions.mode });
				return callback();
			}
		};
		/** @type {Array<{ name: string, mode: string }>} */
		const calls = [];
		await withRepoLock('x', async () => {}, { locks: recording });
		expect(calls).toEqual([{ name: 'gitnote:repo:x', mode: 'exclusive' }]);
	});
});
