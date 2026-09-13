import { z } from 'zod';
import type { Id } from '$convex/_generated/dataModel';
import type { ComposerAttachment } from './attachments';

const storedDraft = z.object({
	prompt: z.string(),
	selectedModel: z.string(),
	reasoningEffort: z.string(),
	fastMode: z.boolean(),
	repositoryKey: z.string().nullable(),
	submission: z.object({ id: z.string(), fingerprint: z.string() }).optional(),
	attachments: z.array(
		z.object({
			localId: z.string(),
			name: z.string(),
			mediaType: z.string(),
			size: z.number(),
			storageId: z.string().optional(),
			uploadedAt: z.number().optional(),
			fileSaved: z.boolean().optional()
		})
	)
});
export type ComposerDraft = Omit<z.infer<typeof storedDraft>, 'attachments'> & {
	attachments: ComposerAttachment[];
};
const memory = new Map<string, ComposerDraft>();

export function completeComposerDraft(
	draft: ComposerDraft,
	submitted: Pick<ComposerDraft, 'repositoryKey' | 'prompt' | 'attachments'>
): ComposerDraft {
	const submittedIds = new Set(submitted.attachments.map((attachment) => attachment.localId));
	const sameProject = draft.repositoryKey === submitted.repositoryKey;
	return {
		...draft,
		submission: undefined,
		prompt: sameProject && draft.prompt.trim() === submitted.prompt.trim() ? '' : draft.prompt,
		attachments: sameProject
			? draft.attachments.filter((attachment) => !submittedIds.has(attachment.localId))
			: draft.attachments.map((attachment) =>
					submittedIds.has(attachment.localId)
						? {
								...attachment,
								storageId: undefined,
								uploadedAt: undefined,
								status: attachment.fileSaved ? 'uploading' : 'error',
								error: attachment.fileSaved
									? undefined
									: 'Attach this file again. Its local copy is unavailable.'
							}
						: attachment
				)
	};
}

export function composerDraftKey(userId: string, threadId: string | null) {
	return `sprocket:composer:${userId}:${threadId ?? 'draft'}`;
}

export function saveComposerDraft(key: string, draft: ComposerDraft) {
	memory.set(key, draft);
	try {
		localStorage.setItem(key, JSON.stringify(storedDraft.parse(draft)));
		return true;
	} catch {
		return false;
	}
}

export function loadComposerDraft(key: string): ComposerDraft | null {
	const current = memory.get(key);
	if (current) return { ...current, attachments: current.attachments.map(refreshAttachment) };
	try {
		const result = storedDraft.safeParse(JSON.parse(localStorage.getItem(key) ?? 'null'));
		if (!result.success) return null;
		return {
			...result.data,
			attachments: result.data.attachments.map((attachment) => {
				// SAFETY: storage IDs originate from upload responses and are revalidated by the server on submission.
				const storageId =
					attachment.uploadedAt && Date.now() - attachment.uploadedAt < 23 * 3_600_000
						? (attachment.storageId as Id<'_storage'> | undefined)
						: undefined;
				return {
					...attachment,
					storageId,
					status: storageId ? 'ready' : attachment.fileSaved ? 'uploading' : 'error',
					error:
						storageId || attachment.fileSaved
							? undefined
							: 'Attach this file again. Its local copy is unavailable.'
				};
			})
		};
	} catch {
		return null;
	}
}

function refreshAttachment(attachment: ComposerAttachment): ComposerAttachment {
	if (
		!attachment.storageId ||
		(attachment.uploadedAt && Date.now() - attachment.uploadedAt < 23 * 3_600_000)
	)
		return attachment;
	return {
		...attachment,
		storageId: undefined,
		status: attachment.fileSaved ? 'uploading' : 'error',
		error: attachment.fileSaved
			? undefined
			: 'Attach this file again. Its local copy is unavailable.'
	};
}

export function updateDraftAttachment(
	key: string,
	localId: string,
	patch: Partial<ComposerAttachment>
): boolean {
	const draft = loadComposerDraft(key);
	if (!draft?.attachments.some((attachment) => attachment.localId === localId)) return false;
	saveComposerDraft(key, {
		...draft,
		attachments: draft.attachments.map((attachment) =>
			attachment.localId === localId ? { ...attachment, ...patch } : attachment
		)
	});
	return true;
}
