import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { decodeScene } from '$lib/kicad-viewer/scene';

// Regenerate with `cargo run --release -p sprocket-kicad --example scene <board> <out>` and gzip.
it('decodes the demo board scene with the current viewer', () => {
	const bytes = gunzipSync(readFileSync(new URL('rp2350-devboard.spks.gzip', import.meta.url)));
	const scene = decodeScene(new Uint8Array(bytes).buffer);

	expect(scene.meta.models).not.toBeNull();
});
