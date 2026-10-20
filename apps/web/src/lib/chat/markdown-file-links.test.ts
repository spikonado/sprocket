import { expect, it, vi } from 'vitest';
import { markdownFileTarget, openMarkdownLink } from './markdown-file-links';

const thread = '/repo/.worktrees/feature';

const roots = [thread, '/repo'];

it.each([
	['src/main%20file.rs', { workspacePath: thread, path: 'src/main file.rs', directory: false }],
	['./src/main.rs', { workspacePath: thread, path: 'src/main.rs', directory: false }],
	['/repo/README.md#L3', { workspacePath: '/repo', path: 'README.md', directory: false }],
	['/repo/.worktrees/feature/a.ts', { workspacePath: thread, path: 'a.ts', directory: false }],
	['../../Cargo.toml', { workspacePath: '/repo', path: 'Cargo.toml', directory: false }],
	['src/', { workspacePath: thread, path: 'src', directory: true }],
	['/repo', { workspacePath: '/repo', path: '', directory: true }],
	['/etc/hosts', { workspacePath: '/etc', path: 'hosts', directory: false }],
	['../../../notes.txt', { workspacePath: '/', path: 'notes.txt', directory: false }],
	['/home/me/', { workspacePath: '/home/me', path: '', directory: true }]
])('resolves %s', (href, target) => {
	expect(markdownFileTarget(href, roots)).toEqual(target);
});

it.each(['https://example.com/a.ts', 'mailto:me@example.com', '#heading', '//example.com/a'])(
	'leaves %s to the browser',
	(href) => {
		expect(markdownFileTarget(href, roots)).toBeNull();
	}
);

it('resolves links relative to the Markdown document', () => {
	expect(
		markdownFileTarget('../src/lib.rs', ['/repo'], {
			workspacePath: '/repo',
			documentPath: 'docs/notes.md'
		})
	).toEqual({ workspacePath: '/repo', path: 'src/lib.rs', directory: false });
});

it('matches Windows paths without regard to case', () => {
	expect(markdownFileTarget('c:/Repo/src/main.rs', ['C:\\repo'])).toEqual({
		workspacePath: 'C:\\repo',
		path: 'src/main.rs',
		directory: false
	});
	expect(markdownFileTarget('D:\\notes.md', ['C:\\repo'])).toEqual({
		workspacePath: 'D:/',
		path: 'notes.md',
		directory: false
	});
});

it('asks the machine whether a link names a folder before opening it', async () => {
	const openFile = vi.fn();
	const openDirectory = vi.fn();

	const entryKind = vi.fn(async ({ path }: { path: string }) =>
		path === 'main.rs' ? ('file' as const) : ('directory' as const)
	);

	const open = (href: string) =>
		openMarkdownLink(markdownFileTarget(href, roots)!, {
			roots,
			entryKind,
			openFile,
			openDirectory
		});

	await open('/tmp/main.rs');
	await open('docs');
	await open('/tmp/build');
	await open('/repo/');

	expect(openFile.mock.calls).toEqual([[{ workspacePath: '/tmp', path: 'main.rs' }]]);
	expect(openDirectory.mock.calls).toEqual([
		[{ workspacePath: thread, path: 'docs' }],
		[{ workspacePath: '/tmp/build', path: '' }],
		[{ workspacePath: '/repo', path: '' }]
	]);
	expect(entryKind).toHaveBeenCalledTimes(3);
});
