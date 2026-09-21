import { describe, expect, it } from 'vitest';
import { containsDraggedFiles } from './composer';

describe('containsDraggedFiles', () => {
	it('recognizes file drags before the browser exposes the files', () => {
		expect(containsDraggedFiles({ types: ['Files'] })).toBe(true);
	});

	it('does not treat dragged text as an attachment', () => {
		expect(containsDraggedFiles({ types: ['text/plain'] })).toBe(false);
		expect(containsDraggedFiles(null)).toBe(false);
	});
});
