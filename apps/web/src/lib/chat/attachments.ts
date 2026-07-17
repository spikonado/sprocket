import type { Id } from '$convex/_generated/dataModel';
import {
	MAX_IMAGE_ATTACHMENTS,
	MAX_IMAGE_ATTACHMENT_BYTES,
	MAX_IMAGE_ATTACHMENT_LABEL,
	supportedImageMediaTypes
} from '$convex/lib/validators';
import { areImageUploadIdsEqual } from '$convex/lib/imageUploads';

export {
	MAX_IMAGE_ATTACHMENTS,
	MAX_IMAGE_ATTACHMENT_BYTES,
	MAX_IMAGE_ATTACHMENT_LABEL,
	areImageUploadIdsEqual
};
export const SUPPORTED_IMAGE_MEDIA_TYPES = supportedImageMediaTypes;

export type ComposerAttachment = {
	localId: string;
	name: string;
	mediaType: string;
	size: number;
	previewUrl: string;
	status: 'uploading' | 'ready' | 'error';
	imageUploadId?: Id<'imageUploads'>;
	error?: string;
};

export function isSupportedImageMediaType(mediaType: string) {
	return (SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

/** Returns an error message when the file cannot be attached, or null when it can. */
export function validateImageAttachmentAddition(
	existingCount: number,
	file: Pick<File, 'name' | 'size' | 'type'>
): string | null {
	if (existingCount >= MAX_IMAGE_ATTACHMENTS) {
		return `You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`;
	}
	if (!isSupportedImageMediaType(file.type)) {
		return `${file.name || 'This file'} is not a supported image. Use JPEG, PNG, GIF, or WebP.`;
	}
	if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
		return `${file.name || 'This image'} is larger than ${MAX_IMAGE_ATTACHMENT_LABEL}.`;
	}
	return null;
}
