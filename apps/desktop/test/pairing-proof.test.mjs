import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePairingProof } from '../pairing-proof.mjs';

const validProof = {
	httpBaseUrl: 'http://127.0.0.1:7731',
	webUiEnabled: true,
	proof: Array.from({ length: 32 }, (_, i) => i)
};

test('accepts a 32-byte pairing proof', () => {
	assert.deepEqual(parsePairingProof(validProof), validProof);
});

test('rejects non-byte proof entries instead of throwing in Buffer.from', () => {
	for (const proof of [
		['x'],
		[{}],
		[1.5],
		[256],
		[-1],
		Array.from({ length: 32 }, () => 'x'),
		Array.from({ length: 32 }, () => null)
	]) {
		assert.equal(parsePairingProof({ ...validProof, proof }), null);
	}
});

test('rejects proofs of the wrong length', () => {
	assert.equal(parsePairingProof({ ...validProof, proof: [] }), null);
	assert.equal(
		parsePairingProof({ ...validProof, proof: Array.from({ length: 31 }, () => 0) }),
		null
	);
	assert.equal(
		parsePairingProof({ ...validProof, proof: Array.from({ length: 33 }, () => 0) }),
		null
	);
});

test('rejects non-object and mismatched payloads', () => {
	assert.equal(parsePairingProof(null), null);
	assert.equal(parsePairingProof({ ...validProof, httpBaseUrl: '  ' }), null);
	assert.equal(parsePairingProof({ ...validProof, webUiEnabled: 'yes' }), null);
});
