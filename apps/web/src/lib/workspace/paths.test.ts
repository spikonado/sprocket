import { describe, expect, it } from 'vitest';
import {
	getBrowseLeafPathSegment,
	isFilesystemBrowseQuery,
	isWindowsVolumeListQuery,
	resolveWorkspacePathFromBrowse,
	withTrailingPathSeparator,
	workspacePathRequiresCreation
} from '$lib/workspace/paths';

describe('workspace paths', () => {
	it('detects filesystem browse queries', () => {
		expect(isFilesystemBrowseQuery('~/projects')).toBe(true);
		expect(isFilesystemBrowseQuery('C:\\dev')).toBe(true);
		expect(isFilesystemBrowseQuery('D:')).toBe(true);
		expect(isFilesystemBrowseQuery('\\\\server\\share')).toBe(true);
		expect(isFilesystemBrowseQuery('\\')).toBe(true);
		expect(isFilesystemBrowseQuery('my-project')).toBe(false);
	});

	it('extracts browse leaf segments', () => {
		expect(getBrowseLeafPathSegment('~/projects/demo/')).toBe('');
		expect(getBrowseLeafPathSegment('~/projects/demo')).toBe('demo');
	});

	it('adds a trailing separator without rewriting drive roots', () => {
		expect(withTrailingPathSeparator('/home/me/robot')).toBe('/home/me/robot/');
		expect(withTrailingPathSeparator('D:\\code')).toBe('D:\\code\\');
		expect(withTrailingPathSeparator('D:')).toBe('D:\\');
		expect(withTrailingPathSeparator('D:\\')).toBe('D:\\');
		expect(withTrailingPathSeparator('/')).toBe('/');
	});

	it('keeps Windows drive-list queries from being treated as concrete paths', () => {
		expect(isWindowsVolumeListQuery('\\')).toBe(true);
		expect(isWindowsVolumeListQuery('/')).toBe(true);
		expect(isWindowsVolumeListQuery('D')).toBe(true);
		expect(isWindowsVolumeListQuery('D:')).toBe(true);
		expect(isWindowsVolumeListQuery('\\D')).toBe(true);
		expect(isWindowsVolumeListQuery('D:\\code')).toBe(false);
		expect(isWindowsVolumeListQuery('\\\\server\\share')).toBe(false);
	});

	it('resolves a typed directory path when browse is inside that directory', () => {
		expect(
			resolveWorkspacePathFromBrowse({
				query: '~/projects/sprocket',
				browseParentPath: '/home/me/projects/sprocket',
				browseEntries: [{ name: 'src', fullPath: '/home/me/projects/sprocket/src' }]
			})
		).toBe('/home/me/projects/sprocket');
	});

	it('marks only missing leaf paths as create targets', () => {
		expect(
			workspacePathRequiresCreation({
				query: '~/projects/sprocket',
				browseParentPath: '/home/me/projects/sprocket',
				browseEntries: [{ name: 'src', fullPath: '/home/me/projects/sprocket/src' }]
			})
		).toBe(false);

		expect(
			workspacePathRequiresCreation({
				query: '~/projects/new-app',
				browseParentPath: '/home/me/projects',
				browseEntries: [{ name: 'sprocket', fullPath: '/home/me/projects/sprocket' }]
			})
		).toBe(true);
	});
});
