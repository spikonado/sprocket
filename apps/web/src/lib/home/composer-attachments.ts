import { useState } from 'react';
import type { Id } from '@convex/_generated/dataModel';
import {
	attachmentMediaType,
	fallbackAttachmentName,
	isPreviewableImageMediaType,
	type ComposerAttachment
} from '$lib/chat/attachments';
import { useStore, type Store } from '$lib/store';
import type { LocalApi } from '$lib/types/sprocket';
import { useLatest } from '$lib/use-latest';

export type ComposerAttachmentApi = Pick<
	LocalApi,
	'uploadTranscriptAttachment' | 'discardTranscriptAttachment'
>;

export type ComposerAttachmentContext = {
	api: ComposerAttachmentApi | null;
	userId: string | null;
	threadId: Id<'threadRecords'> | null;
};

type ClearOptions = {
	discard: boolean;
	userId?: string | null;
	threadId?: Id<'threadRecords'> | null;
};

type Dependencies = {
	getContext: () => ComposerAttachmentContext;
	onError: (message: string) => void;
	localServerRequiredMessage: string;
};

export class ComposerAttachments implements Store<ComposerAttachment[]> {
	items: ComposerAttachment[] = [];
	readonly #listeners = new Set<() => void>();

	constructor(private readonly dependencies: Dependencies) {}

	getSnapshot = () => this.items;

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);

		return () => {
			this.#listeners.delete(listener);
		};
	};

	add(files: File[]) {
		for (const file of files) {
			const localId = crypto.randomUUID();
			const name = fallbackAttachmentName(file);
			const mediaType = attachmentMediaType(file.type);
			this.#setItems([
				...this.items,
				{
					localId,
					name,
					mediaType,
					size: file.size,
					previewFile: isPreviewableImageMediaType(mediaType) ? file : undefined,
					status: 'uploading'
				}
			]);
			void this.#upload(localId, file, name);
		}
	}

	remove(localId: string) {
		const attachment = this.items.find((entry) => entry.localId === localId);

		if (!attachment) return;
		this.#setItems(this.items.filter((entry) => entry.localId !== localId));

		if (attachment.fileId) {
			const { userId, threadId } = this.dependencies.getContext();
			this.#discard({ fileId: attachment.fileId, userId, threadId });
		}
	}

	clear(options: ClearOptions) {
		const context = this.dependencies.getContext();
		const userId = options.userId === undefined ? context.userId : options.userId;
		const threadId = options.threadId === undefined ? context.threadId : options.threadId;

		for (const attachment of this.items) {
			if (options.discard && attachment.fileId) {
				this.#discard({ userId, threadId, fileId: attachment.fileId });
			}
		}

		this.#setItems([]);
	}

	replace(attachments: ComposerAttachment[]) {
		this.#setItems(attachments.map((attachment) => ({ ...attachment })));
	}

	snapshot() {
		return this.items.map((attachment) => ({ ...attachment }));
	}

	#setItems(next: ComposerAttachment[]) {
		this.items = next;

		for (const listener of this.#listeners) listener();
	}

	#update(localId: string, patch: Partial<ComposerAttachment>) {
		if (!this.items.some((entry) => entry.localId === localId)) return false;
		this.#setItems(
			this.items.map((entry) => (entry.localId === localId ? { ...entry, ...patch } : entry))
		);

		return true;
	}

	#discard(args: {
		api?: ComposerAttachmentApi | null;
		userId?: string | null;
		threadId?: Id<'threadRecords'> | null;
		fileId: Id<'files'>;
	}) {
		try {
			const context = this.dependencies.getContext();
			const api = args.api ?? context.api;
			const userId = args.userId ?? context.userId;

			if (!api || !userId) return;
			void api
				.discardTranscriptAttachment({
					userId,
					fileId: args.fileId,
					threadId: args.threadId ?? undefined
				})
				.catch(() => {});
		} catch {
			return;
		}
	}

	async #upload(localId: string, file: File, name: string) {
		const { api, userId, threadId } = this.dependencies.getContext();

		try {
			if (!api) throw new Error(this.dependencies.localServerRequiredMessage);

			if (!userId) throw new Error('Sign in to attach files.');

			const registered = await api.uploadTranscriptAttachment({
				userId,
				name,
				file,
				threadId: threadId ?? undefined
			});

			if ('error' in registered) throw new Error(registered.error);

			const stillAttached = this.#update(localId, {
				status: 'ready',
				fileId: registered.fileId,
				name: registered.name,
				mediaType: registered.mediaType,
				size: registered.size
			});

			if (!stillAttached) {
				this.#discard({ api, userId, threadId, fileId: registered.fileId });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Upload failed.';
			this.#update(localId, { status: 'error', error: message });
			this.dependencies.onError(message);
		}
	}
}

export function useComposerAttachments(
	dependencies: Omit<Dependencies, 'getContext'> & { context: ComposerAttachmentContext }
) {
	const dependenciesRef = useLatest(dependencies);

	const [attachments] = useState(
		() =>
			new ComposerAttachments({
				getContext: () => dependenciesRef.current.context,
				onError: (message) => dependenciesRef.current.onError(message),
				localServerRequiredMessage: dependencies.localServerRequiredMessage
			})
	);

	useStore(attachments);

	return attachments;
}
