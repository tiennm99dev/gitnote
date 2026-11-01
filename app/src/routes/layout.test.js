import { describe, expect, it } from 'vitest';
import * as layout from './+layout.js';

describe('root layout', () => {
	it('renders in the client only', () => {
		expect(layout.ssr).toBe(false);
	});

	it('is not prerendered, so the static adapter serves the SPA fallback', () => {
		expect(layout.prerender).toBe(false);
	});
});
