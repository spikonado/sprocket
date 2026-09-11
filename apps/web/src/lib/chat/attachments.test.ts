import { describe, expect, it } from 'vitest';
import { isPreviewableImageMediaType } from '$lib/chat/attachments';

describe('attachment presentation', () => {
	it('previews only the raster image types the transcript already rendered', () => {
		expect(isPreviewableImageMediaType('image/png')).toBe(true);
		expect(isPreviewableImageMediaType('IMAGE/JPEG')).toBe(true);
		expect(isPreviewableImageMediaType('application/pdf')).toBe(false);
		expect(isPreviewableImageMediaType('image/svg+xml')).toBe(false);
		expect(isPreviewableImageMediaType('')).toBe(false);
	});
});
