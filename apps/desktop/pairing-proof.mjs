import { parseDesktopBootstrap } from './desktop-bootstrap.mjs';

function isProofBytes(value) {
	return (
		Array.isArray(value) &&
		value.length === 32 &&
		value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
	);
}

export function parsePairingProof(value) {
	const bootstrap = parseDesktopBootstrap(value);

	if (
		bootstrap === null ||
		(value.webUiEnabled !== true && value.webUiEnabled !== false) ||
		!isProofBytes(value.proof)
	) {
		return null;
	}

	return {
		httpBaseUrl: bootstrap.httpBaseUrl,
		webUiEnabled: value.webUiEnabled,
		proof: value.proof
	};
}
