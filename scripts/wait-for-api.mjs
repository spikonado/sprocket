import { API_URL } from './dev-config.mjs';

const timeoutMs = 120_000;
const startedAt = Date.now();

while (Date.now() - startedAt < timeoutMs) {
	try {
		const response = await fetch(`${API_URL}/api/health`);
		if (response.ok) {
			process.exit(0);
		}
	} catch {
		// API is still starting.
	}

	await new Promise((resolve) => {
		setTimeout(resolve, 250);
	});
}

console.error(`Timed out waiting for the Sprocket API at ${API_URL}.`);
process.exit(1);
