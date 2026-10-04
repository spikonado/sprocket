import { afterEach, expect, it, vi } from 'vitest';
import { markdownImageUrl } from './markdown-images';

afterEach(() => vi.unstubAllEnvs());

it('uses the configured local API origin for local images', () => {
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

it.each([
	'assets/board.png',
	'./board%20layout.png',
	'../assets/board.svg',
	'/workspace/assets/board.png',
	'C:/workspace/assets/board.png',
	'C:\\workspace\\assets\\board.png'
])('resolves file://%s like the corresponding image path', (path) => {
	const scope = { workspacePath: '/workspace', documentPath: 'docs/notes.md' };

	expect(markdownImageUrl(`file://${path}`, scope)).toBe(markdownImageUrl(path, scope));
});

it.each([
	['/tmp/board.png', undefined, '/tmp/board.png'],
	['./board.png', { documentPath: '/tmp/notes.md' }, '/tmp/./board.png']
])('resolves %s without a workspace', (source, scope, path) => {
	const url = markdownImageUrl(source, scope);

	expect(new URL(url ?? '', 'http://localhost').searchParams.get('path')).toBe(path);
});

it('resolves a Windows file URL like an absolute Windows path', () => {
	expect(markdownImageUrl('file:///C:/workspace/board.png')).toBe(
		markdownImageUrl('C:/workspace/board.png')
	);
});
