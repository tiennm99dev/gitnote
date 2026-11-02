import { describe, expect, it } from 'vitest';
import { repoIdFromRoute, repoRouteId } from './repo-route.js';

describe('repo route ids', () => {
	it.each(['github.com/owner/repo', 'gitlab.com/group/sub/repo', 'localhost:8174/owner/my.repo'])('round-trips %s through a slash-free segment', (id) => {
		const segment = repoRouteId(id);
		expect(segment).not.toMatch(/\/|%2F/i);
		expect(repoIdFromRoute(decodeURIComponent(segment))).toBe(id);
	});
});
