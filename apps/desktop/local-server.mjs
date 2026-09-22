export async function waitForServerReady(baseUrl, timeoutMs = 30_000, fetchImpl = fetch) {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const requestTimeoutMs = Math.max(1, deadline - Date.now());
		const controller = new AbortController();
		const requestTimer = setTimeout(() => controller.abort(), requestTimeoutMs);
		try {
			const response = await fetchImpl(`${baseUrl}/api/health`, {
				signal: controller.signal
			});
			if (response.ok) {
				return;
			}
		} catch {
			// The server may still be starting.
		} finally {
			clearTimeout(requestTimer);
		}

		const retryDelayMs = Math.min(200, deadline - Date.now());
		if (retryDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}

	throw new Error('Timed out waiting for the Sprocket local server.');
}
