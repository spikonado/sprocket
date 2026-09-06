import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	attachmentMediaType,
	fallbackAttachmentName,
	formatAttachmentSize,
	isPreviewableImageMediaType,
	shouldEagerLoadAttachmentPreview,
	triggerAttachmentDownload
} from '$lib/chat/attachments';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('attachment presentation', () => {
	it('previews only the raster image types the transcript already rendered', () => {
		expect(isPreviewableImageMediaType('image/png')).toBe(true);
		expect(isPreviewableImageMediaType('IMAGE/JPEG')).toBe(true);
		expect(isPreviewableImageMediaType('application/pdf')).toBe(false);
		expect(isPreviewableImageMediaType('image/svg+xml')).toBe(false);
		expect(isPreviewableImageMediaType('')).toBe(false);
	});

	it('keeps unknown and empty MIME types attachable', () => {
		expect(attachmentMediaType('text/plain')).toBe('text/plain');
		expect(attachmentMediaType('application/pdf')).toBe('application/pdf');
		expect(attachmentMediaType('')).toBe('application/octet-stream');
		expect(attachmentMediaType('  ')).toBe('application/octet-stream');
	});

	it('uses a generic label when a pasted file has no name', () => {
		expect(fallbackAttachmentName({ name: '' })).toBe('Attached file');
		expect(fallbackAttachmentName({ name: '  spec.pdf  ' })).toBe('spec.pdf');
	});

	it('formats byte sizes for file chips', () => {
		expect(formatAttachmentSize(0)).toBe('0 B');
		expect(formatAttachmentSize(512)).toBe('512 B');
		expect(formatAttachmentSize(1024)).toBe('1 KiB');
		expect(formatAttachmentSize(10 * 1024 * 1024)).toBe('10 MiB');
	});

	it('eager-loads only raster images that do not already have a url', () => {
		expect(shouldEagerLoadAttachmentPreview({ mediaType: 'image/png', url: null })).toBe(true);
		expect(shouldEagerLoadAttachmentPreview({ mediaType: 'IMAGE/JPEG' })).toBe(true);
		expect(
			shouldEagerLoadAttachmentPreview({ mediaType: 'image/webp', url: 'https://files/shot.webp' })
		).toBe(false);
		expect(shouldEagerLoadAttachmentPreview({ mediaType: 'application/pdf', url: null })).toBe(
			false
		);
		expect(shouldEagerLoadAttachmentPreview({ mediaType: 'text/plain' })).toBe(false);
	});

	it('starts a file download from a fetched object url', () => {
		const click = vi.fn();
		const remove = vi.fn();
		const link = {
			href: '',
			download: '',
			rel: '',
			click,
			remove
		};
		const append = vi.fn();
		vi.stubGlobal('document', {
			createElement: () => link,
			body: { append }
		});

		triggerAttachmentDownload('blob:http://localhost/1', 'notes.pdf');

		expect(link.href).toBe('blob:http://localhost/1');
		expect(link.download).toBe('notes.pdf');
		expect(link.rel).toBe('noopener');
		expect(append).toHaveBeenCalledWith(link);
		expect(click).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledTimes(1);
	});
});
