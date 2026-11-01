import { describe, expect, it, vi } from 'vitest';
import { getStorageUsage, repoFsName, repoIdForUrl, requestPersistentStorage } from './fs.js';

describe('repo ids', () => {
	it.each([
		['https://github.com/owner/repo.git', 'github.com/owner/repo'],
		['https://GitHub.com/owner/repo', 'github.com/owner/repo'],
		['https://gitlab.com/group/sub/repo.git/', 'gitlab.com/group/sub/repo'],
		['http://localhost:8175/owner/repo.git', 'localhost:8175/owner/repo']
	])('derives an id from %s', (url, id) => {
		expect(repoIdForUrl(url)).toBe(id);
	});

	it('names one file system per repo', () => {
		expect(repoFsName('github.com/owner/repo')).toBe('gitnote:github.com/owner/repo');
	});

	it.each(['', 'no-path', 'github.com/../evil', 'github.com/o/r?x=1', 'GITHUB.com/o/r'])('rejects the id %j', (id) => {
		expect(() => repoFsName(id)).toThrow(TypeError);
	});
});

describe('requestPersistentStorage', () => {
	it('asks for persistence once', async () => {
		const persist = vi.fn(async () => true);
		expect(await requestPersistentStorage({ persist, persisted: async () => false })).toBe(true);
		expect(persist).toHaveBeenCalledOnce();
	});

	it('does not ask again when storage is already persistent', async () => {
		const persist = vi.fn(async () => true);
		expect(await requestPersistentStorage({ persist, persisted: async () => true })).toBe(true);
		expect(persist).not.toHaveBeenCalled();
	});

	it('reports a refusal', async () => {
		expect(await requestPersistentStorage({ persist: async () => false })).toBe(false);
	});

	it('answers null where the API is missing', async () => {
		expect(await requestPersistentStorage({})).toBeNull();
	});
});

describe('getStorageUsage', () => {
	it('reports the share of quota in use', async () => {
		expect(await getStorageUsage({ estimate: async () => ({ usage: 50, quota: 200 }) })).toEqual({
			usage: 50,
			quota: 200,
			ratio: 0.25,
			nearlyFull: false
		});
	});

	it('flags 70% of quota as nearly full', async () => {
		expect((await getStorageUsage({ estimate: async () => ({ usage: 69, quota: 100 }) }))?.nearlyFull).toBe(false);
		expect((await getStorageUsage({ estimate: async () => ({ usage: 70, quota: 100 }) }))?.nearlyFull).toBe(true);
	});

	it('answers null where the browser reports nothing usable', async () => {
		expect(await getStorageUsage({})).toBeNull();
		expect(await getStorageUsage({ estimate: async () => ({}) })).toBeNull();
		expect(await getStorageUsage({ estimate: async () => ({ usage: 0, quota: 0 }) })).toBeNull();
	});
});
