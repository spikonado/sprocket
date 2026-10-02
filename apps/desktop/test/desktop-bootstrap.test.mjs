import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDesktopBootstrap } from '../desktop-bootstrap.mjs';

test('accepts a non-empty httpBaseUrl', () => {
	assert.deepEqual(parseDesktopBootstrap({ httpBaseUrl: 'http://127.0.0.1:7731' }), {
		httpBaseUrl: 'http://127.0.0.1:7731'
	});
});

test('rejects missing or blank httpBaseUrl', () => {
	for (const value of [
		null,
		{},
		{ httpBaseUrl: '' },
		{ httpBaseUrl: '   ' },
		{ httpBaseUrl: null },
		{ httpBaseUrl: 1 }
	]) {
		assert.equal(parseDesktopBootstrap(value), null);
	}
});
