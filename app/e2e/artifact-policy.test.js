import { describe, expect, it } from 'vitest';
import config from '../playwright.config.js';
import { E2E_TOKEN_ENV, artifactPolicy } from './artifact-policy.js';

describe('artifactPolicy', () => {
	it('keeps failure traces and screenshots when no token is set', () => {
		expect(artifactPolicy({})).toEqual({
			trace: 'retain-on-failure',
			screenshot: 'only-on-failure'
		});
	});

	it('treats a blank token as unset', () => {
		expect(artifactPolicy({ [E2E_TOKEN_ENV]: '  ' }).trace).toBe('retain-on-failure');
	});

	it('records no trace or screenshot when a token is set', () => {
		expect(artifactPolicy({ [E2E_TOKEN_ENV]: 'github_pat_example' })).toEqual({
			trace: 'off',
			screenshot: 'off'
		});
	});
});

describe('playwright config', () => {
	it('applies the artifact policy for the current environment', () => {
		const expected = artifactPolicy(process.env);
		expect(config.use?.trace).toBe(expected.trace);
		expect(config.use?.screenshot).toBe(expected.screenshot);
	});
});
