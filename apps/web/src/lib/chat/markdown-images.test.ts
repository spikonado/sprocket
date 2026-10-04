import { afterEach, expect, it, vi } from 'vitest';
import { markdownImageUrl } from './markdown-images';

afterEach(() => vi.unstubAllEnvs());

it('uses the configured local API origin for workspace images', () => {
	vi.stubEnv('VITE_LOCAL_API_URL', 'https://machine.example.com/');
	const url = markdownImageUrl('board.png', { workspacePath: '/workspace' });

	expect(new URL(url ?? '').origin).toBe('https://machine.example.com');
});

it.each([
	['./board%20layout.png', 'docs/./board layout.png'],
	['../assets/board.svg', 'docs/../assets/board.svg'],
	['/workspace/assets/board.png', '/workspace/assets/board.png'],
	['C:\\workspace\\assets\\board.png', 'C:\\workspace\\assets\\board.png']
])('resolves %s relative to the Markdown document when appropriate', (source, path) => {
	const url = markdownImageUrl(source, {
		workspacePath: '/workspace',
		documentPath: 'docs/notes.md'
	});

	const parsed = new URL(url ?? '', 'http://localhost');

	expect(parsed.pathname).toBe('/api/workspace/image');
	expect(parsed.searchParams.get('workspacePath')).toBe('/workspace');
	expect(parsed.searchParams.get('path')).toBe(path);
});

it('resolves chat images from the workspace root and keeps remote URLs intact', () => {
	expect(markdownImageUrl('assets/board.png', { workspacePath: '/workspace' })).toBe(
		'/api/workspace/image?workspacePath=%2Fworkspace&path=assets%2Fboard.png'
	);
	expect(markdownImageUrl('https://example.com/board.png')).toBe('https://example.com/board.png');
});
