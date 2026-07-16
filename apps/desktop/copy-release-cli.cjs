const fs = require('node:fs');
const path = require('node:path');

const extension = process.platform === 'win32' ? '.exe' : '';
const source = path.resolve(__dirname, `../../target/release/sprocket${extension}`);
const destination = path.join(
	__dirname,
	'dist',
	`sprocket-${process.platform}-${process.arch}${extension}`
);

fs.copyFileSync(source, destination);
if (process.platform !== 'win32') {
	fs.chmodSync(destination, 0o755);
}

console.log(`Wrote CLI artifact to ${destination}`);
