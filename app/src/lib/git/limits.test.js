import { describe, expect, it } from 'vitest';
import {
	checkFileSize,
	checkPushSize,
	checkRepoSize,
	checkUnpushedSize,
	formatBytes,
	limitsFor,
	providerForUrl,
	RELAY_MAX_BODY_BYTES
} from './limits.js';

const MB = 1_000_000;

describe('file limits', () => {
	it.each(['github', 'gitlab'])('passes a file at the warning line on %s', (provider) => {
		expect(checkFileSize(provider, 'a.bin', 50 * MB)).toBeNull();
	});

	it.each(['github', 'gitlab'])('warns about a 60 MB file on %s', (provider) => {
		expect(checkFileSize(provider, 'a.bin', 60 * MB)).toMatchObject({ level: 'warn', path: 'a.bin', limit: 50 * MB });
	});

	it('blocks over 100 MiB on GitHub, and not below', () => {
		const limit = 100 * 1024 * 1024;
		expect(checkFileSize('github', 'a.bin', limit)?.level).toBe('warn');
		const blocked = checkFileSize('github', 'a.bin', limit + 1);
		expect(blocked).toMatchObject({ level: 'block', limit });
		expect(blocked?.message).toContain("GitHub's per-file limit");
	});

	it('says a GitHub file over the relay cap commits but cannot be pushed', () => {
		const finding = checkFileSize('github', 'a.bin', 96 * MB);
		expect(finding).toMatchObject({ level: 'warn', limit: RELAY_MAX_BODY_BYTES });
		expect(finding?.message).toContain('cannot be pushed through the relay');
		expect(checkFileSize('github', 'a.bin', RELAY_MAX_BODY_BYTES)?.message).not.toContain('cannot be pushed');
	});

	it('blocks a 120 MB file on GitHub', () => {
		expect(checkFileSize('github', 'a.bin', 120 * MB)?.level).toBe('block');
	});

	it('blocks over the relay cap on GitLab', () => {
		expect(checkFileSize('gitlab', 'a.bin', RELAY_MAX_BODY_BYTES)?.level).toBe('warn');
		const blocked = checkFileSize('gitlab', 'a.bin', RELAY_MAX_BODY_BYTES + 1);
		expect(blocked?.level).toBe('block');
		expect(blocked?.message).toContain("relay's per-push limit");
	});
});

describe('push limits', () => {
	it.each(['github', 'gitlab'])('blocks an estimated 120 MB push on %s', (provider) => {
		const finding = checkPushSize(provider, 120 * MB);
		expect(finding).toMatchObject({ level: 'block', limit: RELAY_MAX_BODY_BYTES });
		expect(finding?.message).toContain('smaller commits');
	});

	it('points at an operation the engine has', () => {
		expect(checkPushSize('github', 120 * MB)?.message).toContain('Undo the unpushed commits');
	});

	it('warns when unpushed commits would pass the cap together', () => {
		expect(checkUnpushedSize('github', RELAY_MAX_BODY_BYTES)).toBeNull();
		expect(checkUnpushedSize('gitlab', RELAY_MAX_BODY_BYTES + 1)).toMatchObject({ level: 'warn', limit: RELAY_MAX_BODY_BYTES });
	});

	it('passes a push at the cap', () => {
		expect(checkPushSize('github', RELAY_MAX_BODY_BYTES)).toBeNull();
	});
});

describe('helpers', () => {
	it('rejects an unknown provider', () => {
		expect(() => limitsFor('sourceforge')).toThrow(TypeError);
		expect(() => limitsFor('constructor')).toThrow(TypeError);
	});

	it('warns before cloning a repo over 300 MB', () => {
		expect(checkRepoSize(300 * MB)).toBeNull();
		expect(checkRepoSize(300 * MB + 1)?.level).toBe('warn');
	});

	it.each([
		['https://github.com/o/r.git', 'github'],
		['https://GitLab.com/g/s/r.git', 'gitlab'],
		['https://example.com/o/r.git', null],
		['https://github.com.evil.example/o/r.git', null],
		['not a url', null]
	])('maps %s to its provider', (url, provider) => {
		expect(providerForUrl(url)).toBe(provider);
	});

	it('formats sizes', () => {
		expect(formatBytes(999)).toBe('999 B');
		expect(formatBytes(1500)).toBe('1.5 KB');
		expect(formatBytes(95 * MB)).toBe('95.0 MB');
	});
});
