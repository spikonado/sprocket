/** Yields each newline-terminated line the port sends until it closes. */
export async function* readLines(port) {
	const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
	let buffered = '';

	try {
		while (true) {
			const { value, done } = await reader.read();

			if (done) return;
			buffered += value;
			const lines = buffered.split('\n');
			buffered = lines.pop();

			for (const line of lines) yield line.trim();
		}
	} finally {
		reader.releaseLock();
	}
}
