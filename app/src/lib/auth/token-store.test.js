import { describe, expect, it } from 'vitest';
import { generateKey, seal, unseal } from './token-store.js';

const VALUE = { accessToken: 'ghu_plaintext_secret', refreshToken: 'ghr_plaintext_secret' };

describe('sealed records', () => {
	it('come back as stored', async () => {
		const key = await generateKey();
		expect(await unseal(key, 'github', await seal(key, 'github', VALUE))).toEqual(VALUE);
	});

	it('hold no plaintext', async () => {
		const { data } = await seal(await generateKey(), 'github', VALUE);
		expect(Buffer.from(data).toString('latin1')).not.toContain('plaintext_secret');
	});

	it('use a new IV for every write', async () => {
		const key = await generateKey();
		const [first, second] = [await seal(key, 'github', VALUE), await seal(key, 'github', VALUE)];
		expect(first.iv).not.toEqual(second.iv);
		expect(Buffer.from(first.data).equals(Buffer.from(second.data))).toBe(false);
	});

	it('use a key that cannot be exported', async () => {
		const key = await generateKey();
		expect(key.extractable).toBe(false);
		await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
	});

	it('read as null under another key, another name, or after tampering', async () => {
		const key = await generateKey();
		const record = await seal(key, 'github', VALUE);
		expect(await unseal(await generateKey(), 'github', record)).toBeNull();
		expect(await unseal(key, 'gitlab', record)).toBeNull();
		const bytes = new Uint8Array(record.data.slice(0));
		bytes[0] ^= 1;
		expect(await unseal(key, 'github', { iv: record.iv, data: bytes.buffer })).toBeNull();
	});
});
