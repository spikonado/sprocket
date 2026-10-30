// `tsci dev` listens on every interface without auth, and its file API writes outside the project,
// so keep it on loopback and refuse requests whose Host isn't loopback (DNS rebinding).
import http from 'node:http';
import net from 'node:net';

const loopbackHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

const isString = (value) => String(value) === value;

/** Rewrites any TCP `listen` call to bind loopback; Unix sockets and handles pass through. */
function loopbackListenArgs(args) {
	const [first, ...rest] = args;

	if (first instanceof Object && !(first instanceof Function)) {
		const socketOrHandle = 'path' in first || 'fd' in first || '_handle' in first;

		return socketOrHandle ? args : [{ ...first, host: '127.0.0.1' }, ...rest];
	}

	if (isString(first) && !/^\d+$/.test(first)) return args;
	const afterPort = first instanceof Function ? args : rest;

	if (isString(afterPort[0])) afterPort.shift();

	return [first instanceof Function || first === undefined ? 0 : first, '127.0.0.1', ...afterPort];
}

function onlyLoopbackRequests(server) {
	const handlers = server.listeners('request');
	server.removeAllListeners('request');
	server.on('request', (request, response) => {
		if (!loopbackHost.test(request.headers.host ?? '')) {
			response.writeHead(403);
			response.end();

			return;
		}

		for (const handler of handlers) handler.call(server, request, response);
	});
}

for (const Server of [net.Server, http.Server]) {
	const listen = Server.prototype.listen;
	Server.prototype.listen = function (...args) {
		if (this instanceof http.Server) onlyLoopbackRequests(this);

		return listen.apply(this, loopbackListenArgs(args));
	};
}
