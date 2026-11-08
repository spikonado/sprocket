// Preloaded into the dev server so verification can show which origins the server called.
const { subscribe } = require('node:diagnostics_channel');
const { appendFileSync } = require('node:fs');

const log = process.env.SITE_NET_LOG;

function write(method, url) {
	if (log) appendFileSync(log, `${new Date().toISOString()} ${process.pid} ${method} ${url}\n`);
}

subscribe('undici:request:create', ({ request }) =>
	write(request.method, request.origin + request.path)
);
subscribe('http.client.request.start', ({ request }) =>
	write(request.method, `${request.protocol}//${request.host}${request.path}`)
);
