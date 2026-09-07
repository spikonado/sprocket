import { runUpdateApi } from './update.js';

const { exitCode, payload } = await runUpdateApi(process.argv[2]);
process.stdout.write(`${JSON.stringify(payload)}\n`);
process.exitCode = exitCode;
