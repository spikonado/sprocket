function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseNonEmptyString(value) {
	// Accepts only primitive non-empty strings (no boxed strings/arrays/objects).
	if (value === null || value === undefined || Array.isArray(value) || value === Object(value)) {
		return null;
	}
	if (value !== `${value}`) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

// HMAC-SHA256 proofs are exactly 32 bytes. Anything else is rejected here so
// a hostile pairing response fails closed instead of throwing in Buffer.from.
function isProofBytes(value) {
	return (
		Array.isArray(value) &&
		value.length === 32 &&
		value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
	);
}

export function parsePairingProof(value) {
	if (!isPlainObject(value)) {
		return null;
	}
	const httpBaseUrl = parseNonEmptyString(value.httpBaseUrl);
	if (
		httpBaseUrl === null ||
		(value.webUiEnabled !== true && value.webUiEnabled !== false) ||
		!isProofBytes(value.proof)
	) {
		return null;
	}
	return {
		httpBaseUrl,
		webUiEnabled: value.webUiEnabled,
		proof: value.proof
	};
}
