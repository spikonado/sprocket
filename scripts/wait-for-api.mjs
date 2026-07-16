import { DEV_API_URL } from '../apps/desktop/local-config.mjs';

const timeoutMs = 120_000;
const startedAt = Date.now();

while (Date.now() - startedAt < timeoutMs) {
	try {
		const response = await fetch(`${DEV_API_URL}/api/health`);
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

console.error(`Timed out waiting for the Sprocket API at ${DEV_API_URL}.`);
process.exit(1);
