import type { Id } from '$convex/_generated/dataModel';
import { areImageUploadIdsEqual } from '$convex/lib/imageUploads';

export { areImageUploadIdsEqual };

const PREVIEWABLE_IMAGE_MEDIA_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp'
]);

export type ComposerAttachment = {
	localId: string;
	name: string;
	mediaType: string;
	size: number;
	previewUrl?: string;
	status: 'uploading' | 'ready' | 'error';
	imageUploadId?: Id<'imageUploads'>;
	error?: string;
};

export function isPreviewableImageMediaType(mediaType: string) {
	return PREVIEWABLE_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase());
}

export function attachmentMediaType(type: string) {
	const mediaType = type.trim();
	return mediaType.length > 0 ? mediaType : 'application/octet-stream';
}

export function fallbackAttachmentName(file: Pick<File, 'name'>) {
	const name = file.name.trim();
	return name.length > 0 ? name : 'Attached file';
}

export function formatAttachmentSize(bytes: number) {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MiB`;
}

export function revokeAttachmentPreview(previewUrl: string | undefined) {
	if (previewUrl?.startsWith('blob:')) {
		URL.revokeObjectURL(previewUrl);
	}
}

export function shouldEagerLoadAttachmentPreview(attachment: {
	mediaType: string;
	url?: string | null;
}) {
	return !attachment.url && isPreviewableImageMediaType(attachment.mediaType);
}

export function triggerAttachmentDownload(url: string, name: string) {
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	link.rel = 'noopener';
	document.body.append(link);
	link.click();
	link.remove();
}
