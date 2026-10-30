// `tsci dev` listens on every interface without auth, and its file API writes outside the project,
// so keep it on loopback and refuse requests whose Host isn't loopback (DNS rebinding).
import http from 'node:http';
import net from 'node:net';

const loopbackHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

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
		if (typeof args[0] === 'number' && (args.length === 1 || typeof args[1] === 'function')) {
			args.splice(1, 0, '127.0.0.1');
		}
		return listen.apply(this, args);
	};
}
