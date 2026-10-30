import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import './localhost-only.mjs';

test('binds every TCP listen form to loopback', async () => {
	const forms = [
		(server) => server.listen(0),
		(server) => server.listen(0, '0.0.0.0'),
		(server) => server.listen({ port: 0, host: '::' }),
		(server) => server.listen(() => {})
	];

	for (const listen of forms) {
		const server = http.createServer();
		listen(server);
		await once(server, 'listening');
		assert.equal(server.address().address, '127.0.0.1');
		server.close();
	}
});

test('refuses requests whose Host is not loopback', async () => {
	const server = http.createServer((request, response) => response.end('ok'));
	server.listen(0);
	await once(server, 'listening');
	const { port } = server.address();

	const status = (host) =>
		new Promise((resolve, reject) => {
			http
				.get({ port, host: '127.0.0.1', headers: { host } }, (response) => {
					response.resume();
					resolve(response.statusCode);
				})
				.on('error', reject);
		});

	assert.equal(await status(`127.0.0.1:${port}`), 200);
	assert.equal(await status('rebound.example'), 403);
	server.close();
});
