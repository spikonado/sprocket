import { spawn } from 'node:child_process';
import { createRunCommand } from '../lib/update.js';

const pidFile = process.argv[2];
const nested = [
	'const {spawn}=require("node:child_process");',
	'const {writeFileSync}=require("node:fs");',
	'const g=spawn(process.execPath,["-e","setInterval(()=>{},6e4)"],{stdio:"ignore"});',
	'writeFileSync(process.env.SPROCKET_TEST_PID_FILE,String(g.pid));',
	'setInterval(()=>{},6e4);'
].join('');

const runCommand = createRunCommand(spawn);
await runCommand(process.execPath, ['-e', nested], {
	env: { ...process.env, SPROCKET_UPDATE_MANAGED: '1', SPROCKET_TEST_PID_FILE: pidFile },
	timeout: 500,
	platform: process.platform
});
