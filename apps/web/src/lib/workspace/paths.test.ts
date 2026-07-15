import { describe, expect, it } from 'vitest';
import {
	appendBrowsePathSegment,
	getBrowseLeafPathSegment,
	isFilesystemBrowseQuery,
	resolveWorkspacePathFromBrowse,
	workspacePathRequiresCreation
} from '$lib/workspace/paths';

describe('workspace paths', () => {
	it('detects filesystem browse queries', () => {
		expect(isFilesystemBrowseQuery('~/projects')).toBe(true);
		expect(isFilesystemBrowseQuery('C:\\dev')).toBe(true);
		expect(isFilesystemBrowseQuery('my-project')).toBe(false);
	});

	it('extracts browse leaf segments', () => {
		expect(getBrowseLeafPathSegment('~/projects/demo/')).toBe('');
		expect(getBrowseLeafPathSegment('~/projects/demo')).toBe('demo');
	});

	it('appends browse segments with separators', () => {
		expect(appendBrowsePathSegment('~/projects/', 'demo')).toBe('~/projects/demo/');
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
