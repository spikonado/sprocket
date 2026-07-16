const fs = require('node:fs');
const path = require('node:path');

const extension = process.platform === 'win32' ? '.exe' : '';
const source = path.resolve(__dirname, `../../target/release/sprocket${extension}`);
const webSource = path.resolve(__dirname, '../web/dist');
const bundle = path.join(__dirname, 'dist', `sprocket-cli-${process.platform}-${process.arch}`);
const destination = path.join(bundle, `sprocket${extension}`);
const webDestination = path.join(bundle, 'web', 'dist');

if (!fs.existsSync(source)) {
	throw new Error(`Release CLI not found at ${source}; run the release build first.`);
}
if (!fs.existsSync(path.join(webSource, 'index.html'))) {
	throw new Error(`Web build not found at ${webSource}; build the web app first.`);
}

fs.rmSync(bundle, { recursive: true, force: true });
fs.mkdirSync(bundle, { recursive: true });
fs.copyFileSync(source, destination);
fs.cpSync(webSource, webDestination, { recursive: true });
if (process.platform !== 'win32') {
	fs.chmodSync(destination, 0o755);
}

console.log(`Wrote standalone CLI bundle to ${bundle}`);
