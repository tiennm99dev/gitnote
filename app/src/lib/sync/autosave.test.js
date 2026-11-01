import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../git/errors.js';
import { autosaveMessage, createAutosave } from './autosave.js';

const MINUTE = 60_000;

// The result's shape is inferred, and the tests read it by name.
// eslint-disable-next-line jsdoc/require-returns
/**
 * A record of what autosave asked for, in order, over a repo described by `work`.
 * @param {{ merge?: boolean, paths?: string[], ahead?: number, pull?: { ok: boolean, status?: string, code?: string }, skipped?: string[], draftPaths?: string[] }} [scene]
 */
function setUp(scene = {}) {
	const work = { merge: scene.merge ?? false, paths: scene.paths ?? [], ahead: scene.ahead ?? 0 };
	const environment = { visible: true, online: true };
	/** @type {string[]} */
	const calls = [];
	/** @type {string[]} */
	const messages = [];
	/** @type {unknown[]} */
	const failures = [];
	const ops = {
		saveDrafts: vi.fn(async () => {
			calls.push('saveDrafts');
			work.paths = [...work.paths, ...(scene.draftPaths ?? [])];
			scene.draftPaths = [];
			return { saved: [], skipped: scene.skipped ?? [] };
		}),
		readWork: vi.fn(async () => ({ ...work })),
		commit: vi.fn(async (/** @type {string[]} */ _paths, /** @type {string} */ message) => {
			calls.push('commit');
			messages.push(message);
			work.paths = [];
			work.ahead += 1;
			return { ok: true };
		}),
		pull: vi.fn(async () => {
			calls.push('pull');
			if (scene.pull?.status === 'conflict') work.merge = true;
			return scene.pull ?? { ok: true, status: 'up_to_date' };
		}),
		push: vi.fn(async () => {
			calls.push('push');
			work.ahead = 0;
			return { ok: true };
		}),
		queuePush: vi.fn(() => void calls.push('queuePush'))
	};
	const autosave = createAutosave({
		ops,
		isVisible: () => environment.visible,
		isOnline: () => environment.online,
		onError: (error) => failures.push(error)
	});
	return { work, environment, calls, messages, failures, ops, autosave };
}

/**
 * @param {ReturnType<typeof setUp>} context
 * @param {number} [intervalMinutes]
 * @returns {Promise<void>}
 */
const turnOn = async ({ autosave }, intervalMinutes = 5) => {
	await autosave.configure({ enabled: true, intervalMinutes });
};

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('on the timer', () => {
	it('commits with the autosave message, then pulls, then pushes', async () => {
		const context = setUp({ paths: ['a.md', 'b.md'] });
		await turnOn(context);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(context.calls).toEqual(['saveDrafts', 'commit', 'pull', 'push']);
		expect(context.messages).toEqual(['autosave: a.md, b.md']);
	});

	it('does nothing when there are no changes', async () => {
		const context = setUp();
		await turnOn(context);
		await vi.advanceTimersByTimeAsync(15 * MINUTE);
		expect(context.ops.commit).not.toHaveBeenCalled();
		expect(context.ops.pull).not.toHaveBeenCalled();
		expect(context.ops.push).not.toHaveBeenCalled();
	});

	it('commits text the editor had not saved yet', async () => {
		const context = setUp({ draftPaths: ['draft.md'] });
		await turnOn(context);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(context.messages).toEqual(['autosave: draft.md']);
	});

	it('runs at the chosen interval and not before', async () => {
		const context = setUp({ paths: ['a.md'] });
		await turnOn(context, 1);
		await vi.advanceTimersByTimeAsync(MINUTE - 1);
		expect(context.ops.commit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(context.ops.commit).toHaveBeenCalledTimes(1);
	});

	it('picks up a changed interval', async () => {
		const context = setUp({ paths: ['a.md'] });
		await turnOn(context, 30);
		await context.autosave.configure({ enabled: true, intervalMinutes: 1 });
		await vi.advanceTimersByTimeAsync(MINUTE);
		expect(context.ops.commit).toHaveBeenCalledTimes(1);
	});

	it('stays quiet when off, and stops when turned off', async () => {
		const context = setUp({ paths: ['a.md'] });
		await context.autosave.configure({ enabled: false, intervalMinutes: 1 });
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(context.ops.commit).not.toHaveBeenCalled();

		await turnOn(context, 1);
		await context.autosave.configure({ enabled: false, intervalMinutes: 1 });
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(context.ops.commit).not.toHaveBeenCalled();
		expect(get(context.autosave).enabled).toBe(false);
	});

	it('pushes commits an earlier run could not, even with no new changes', async () => {
		const context = setUp({ ahead: 0 });
		await turnOn(context);
		context.work.ahead = 2;
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(context.calls).toEqual(['saveDrafts', 'pull', 'push']);
	});

	it('lists a note it had to leave out', async () => {
		const context = setUp({ skipped: ['changed.md'] });
		await turnOn(context);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(get(context.autosave).skipped).toEqual(['changed.md']);
	});
});

describe('with a conflict', () => {
	it('skips the run entirely while a merge is open', async () => {
		const context = setUp({ merge: true, paths: ['clash.md'] });
		await turnOn(context);
		await vi.advanceTimersByTimeAsync(15 * MINUTE);
		expect(context.ops.saveDrafts).not.toHaveBeenCalled();
		expect(context.ops.commit).not.toHaveBeenCalled();
		expect(context.ops.pull).not.toHaveBeenCalled();
		expect(context.ops.push).not.toHaveBeenCalled();
	});

	it('stops before pushing when its pull conflicts, and stands aside after', async () => {
		const context = setUp({ paths: ['a.md'], pull: { ok: true, status: 'conflict' } });
		await turnOn(context);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(context.calls).toEqual(['saveDrafts', 'commit', 'pull']);

		context.work.paths = ['later.md'];
		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		expect(context.calls).toEqual(['saveDrafts', 'commit', 'pull']);
	});

	it('starts again by itself once the merge is closed', async () => {
		const context = setUp({ merge: true, paths: ['a.md'] });
		await turnOn(context);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		context.work.merge = false;
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(context.ops.commit).toHaveBeenCalledTimes(1);
	});

	it('does not commit on hiding while a merge is open', async () => {
		const context = setUp({ merge: true, paths: ['a.md'] });
		await turnOn(context);
		await context.autosave.handleHidden();
		expect(context.ops.commit).not.toHaveBeenCalled();
	});
});

describe('hiding and showing', () => {
	it('commits locally on hide, without touching the network', async () => {
		const context = setUp({ paths: ['a.md'] });
		await turnOn(context);
		context.environment.visible = false;
		await context.autosave.handleHidden();
		expect(context.calls).toEqual(['saveDrafts', 'commit']);
	});

	it('runs no timer while hidden', async () => {
		const context = setUp({ paths: [] });
		await turnOn(context);
		context.environment.visible = false;
		await context.autosave.handleHidden();
		context.work.paths = ['a.md'];
		await vi.advanceTimersByTimeAsync(30 * MINUTE);
		expect(context.ops.commit).not.toHaveBeenCalled();
	});

	it('pushes on show what the hide committed, pulling first, and restarts the timer', async () => {
		const context = setUp({ paths: ['a.md'] });
		await turnOn(context);
		context.environment.visible = false;
		await context.autosave.handleHidden();
		context.environment.visible = true;
		await context.autosave.handleVisible();
		expect(context.calls).toEqual(['saveDrafts', 'commit', 'pull', 'push']);

		context.work.paths = ['b.md'];
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(context.ops.commit).toHaveBeenCalledTimes(2);
	});

	it('shows with nothing to push and makes no request', async () => {
		const context = setUp();
		await turnOn(context);
		await context.autosave.handleVisible();
		expect(context.ops.pull).not.toHaveBeenCalled();
		expect(context.ops.push).not.toHaveBeenCalled();
	});

	it('does nothing on hide or show when off', async () => {
		const context = setUp({ paths: ['a.md'], ahead: 1 });
		await context.autosave.handleHidden();
		await context.autosave.handleVisible();
		await context.autosave.handleOnline();
		expect(context.calls).toEqual([]);
	});
});

describe('launching and the network', () => {
	it('pushes on launch what an earlier session committed', async () => {
		const context = setUp({ ahead: 1 });
		await turnOn(context);
		expect(context.calls).toEqual(['pull', 'push']);
	});

	it('queues the push when offline, and sends it when the network returns', async () => {
		const context = setUp({ paths: ['a.md'] });
		context.environment.online = false;
		await turnOn(context);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(context.calls).toEqual(['saveDrafts', 'commit', 'queuePush']);

		context.environment.online = true;
		await context.autosave.handleOnline();
		expect(context.calls).toEqual(['saveDrafts', 'commit', 'queuePush', 'pull', 'push']);
	});

	it('still tries the push when local changes hold its pull back', async () => {
		const context = setUp({ ahead: 1, pull: { ok: false, code: ErrorCode.DIRTY_TREE } });
		await turnOn(context);
		expect(context.calls).toEqual(['pull', 'push']);
	});

	it('does not push after a pull that failed for any other reason', async () => {
		const context = setUp({ ahead: 1, pull: { ok: false, code: ErrorCode.NETWORK } });
		await turnOn(context);
		expect(context.calls).toEqual(['pull']);
	});
});

describe('when something throws', () => {
	it('hands the failure over from a timer, and keeps ticking', async () => {
		const context = setUp({ paths: ['a.md'] });
		const failure = new Error('storage went away');
		context.ops.saveDrafts.mockRejectedValueOnce(failure);
		await turnOn(context);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(context.failures).toEqual([failure]);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(context.ops.commit).toHaveBeenCalledTimes(1);
	});
});

describe('autosaveMessage', () => {
	it('names the paths, and cuts a long list short', () => {
		expect(autosaveMessage(['a.md'])).toBe('autosave: a.md');
		expect(autosaveMessage(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('autosave: a, b, c, d, e and 2 more');
	});
});
