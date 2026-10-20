import { expect, it } from 'vitest';
import { markdownFileTarget } from './markdown-file-links';

const roots = ['/repo/.worktrees/feature', '/repo'];

it.each([
	['src/main%20file.rs', { workspacePath: '/repo/.worktrees/feature', path: 'src/main file.rs' }],
	['./src/main.rs:12:4', { workspacePath: '/repo/.worktrees/feature', path: 'src/main.rs' }],
	['/repo/README.md#L3', { workspacePath: '/repo', path: 'README.md' }],
	[
		'file:///repo/.worktrees/feature/a.ts',
		{ workspacePath: '/repo/.worktrees/feature', path: 'a.ts' }
	],
	['../../Cargo.toml', { workspacePath: '/repo', path: 'Cargo.toml' }]
])('opens %s in the files tab', (href, file) => {
	expect(markdownFileTarget(href, roots)).toEqual(file);
});

it.each([
	'https://example.com/a.ts',
	'mailto:me@example.com',
	'#heading',
	'/etc/hosts',
	'../../../x',
	'src/'
])('leaves %s to the browser', (href) => {
	expect(markdownFileTarget(href, roots)).toBeNull();
});

it('resolves links relative to the Markdown document', () => {
	expect(
		markdownFileTarget('../src/lib.rs', ['/repo'], {
			workspacePath: '/repo',
			documentPath: 'docs/notes.md'
		})
	).toEqual({ workspacePath: '/repo', path: 'src/lib.rs' });
});

it('matches Windows paths without regard to case', () => {
	expect(markdownFileTarget('c:/Repo/src/main.rs', ['C:\\repo'])).toEqual({
		workspacePath: 'C:\\repo',
		path: 'src/main.rs'
	});
});
