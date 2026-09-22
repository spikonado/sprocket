import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForServerReady } from '../local-server.mjs';

test('server readiness times out when a health request never responds', async () => {
	let requestAborted = false;
	const hangingFetch = (_url, { signal }) =>
		new Promise((_resolve, reject) => {
			signal.addEventListener(
				'abort',
				() => {
					requestAborted = true;
					reject(signal.reason);
				},
				{ once: true }
			);
		});

	await assert.rejects(
		waitForServerReady('http://127.0.0.1:7731', 20, hangingFetch),
		/Timed out waiting for the Sprocket local server/
	);
	assert.equal(requestAborted, true);
});
