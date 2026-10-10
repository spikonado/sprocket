import { run } from '../lib/launcher.js';

const native = `
const { writeFileSync } = require('node:fs');
let stopping = false;
function stop() {
	if (stopping) return;
	stopping = true;
	setTimeout(() => {
		writeFileSync(process.argv[1], 'completed');
		console.log('SHUTDOWN_COMPLETED');
		process.exit(0);
	}, 200);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('READY');
setInterval(() => {}, 60_000);
`;

process.exitCode = await run(process.execPath, ['-e', native, process.argv[2]]);
