import { run } from '../lib/launcher.js';

const native = `
let stopping = false;
function stop() {
	if (stopping) return;
	stopping = true;
	setTimeout(() => {
		console.log('SHUTDOWN_COMPLETED');
		process.exit(0);
	}, 200);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('READY');
setInterval(() => {}, 60_000);
`;

process.exitCode = await run(process.execPath, ['-e', native]);
