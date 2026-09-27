import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import { useComposerAttachments } from '$lib/home/composer-attachments';
import type { DesktopApi } from '$lib/types/sprocket';

type AttachmentContext = {
	api: DesktopApi | null;
	userId: string | null;
	threadId: Id<'threadRecords'> | null;
};

type UploadResult = {
	storageId: Id<'_storage'>;
	name: string;
	mediaType: string;
	size: number;
	url: string;
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function createDesktopApi(overrides: { uploadFails?: Error } = {}) {
	const uploads: Array<{ userId: string; name: string }> = [];
	const discards: Array<{ userId: string; storageId: string }> = [];
	const pending: Array<{ resolve: (value: UploadResult) => void }> = [];
	const api = {
		uploadTranscriptAttachment: vi.fn(async (args: { userId: string; name: string }) => {
			uploads.push({ userId: args.userId, name: args.name });
			if (overrides.uploadFails) throw overrides.uploadFails;
			const result = deferred<UploadResult>();
			pending.push(result);
			return result.promise;
		}),
		discardTranscriptAttachment: vi.fn(async (args: { userId: string; storageId: string }) => {
			discards.push({ userId: args.userId, storageId: args.storageId });
		})
	} as unknown as DesktopApi;
	return { api, uploads, discards, pending };
}

type AttachmentHarness = {
	context: AttachmentContext;
	onError: (message: string) => void;
};

function attachmentHarness(
	context: AttachmentContext,
	onError: (message: string) => void = () => {}
): AttachmentHarness {
	return { context, onError };
}

function renderAttachments(harness: AttachmentHarness) {
	return renderHook(() =>
		useComposerAttachments(() => ({
			getContext: () => harness.context,
			onError: harness.onError,
			localServerRequiredMessage: 'Connect to a running Sprocket server to use this project.'
		}))
	);
}

function textFile(name = 'notes.txt') {
	return new File(['contents'], name, { type: 'text/plain' });
}

async function flushUploadStart() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

it('uploads with the context committed when the file is added, not the first render', async () => {
	const { api, uploads, pending } = createDesktopApi();
	const harness = attachmentHarness({ api: null, userId: null, threadId: null });
	const { result, rerender } = renderAttachments(harness);

	rerender();
	harness.context = { api, userId: 'user-a', threadId: null };
	act(() => {
		result.current.add([textFile()]);
	});
	await flushUploadStart();

	expect(uploads).toEqual([{ userId: 'user-a', name: 'notes.txt' }]);

	await act(async () => {
		pending[0].resolve({
			storageId: 'storage-1' as Id<'_storage'>,
			name: 'notes.txt',
			mediaType: 'text/plain',
			size: 8,
			url: 'blob:local'
		});
	});
	expect(result.current.items[0]?.status).toBe('ready');
	expect(result.current.items[0]?.storageId).toBe('storage-1');
});

it('reports an unavailable server when the context is still the unconnected one', async () => {
	const onError = vi.fn();
	const harness = attachmentHarness({ api: null, userId: null, threadId: null }, onError);
	const { result } = renderAttachments(harness);

	act(() => {
		result.current.add([textFile()]);
	});
	await flushUploadStart();

	expect(onError).toHaveBeenCalledWith(
		'Connect to a running Sprocket server to use this project.'
	);
	expect(result.current.items[0]?.status).toBe('error');
});

it('discards a late upload under the account that owned it, not the current one', async () => {
	const { api, pending, discards } = createDesktopApi();
	const harness = attachmentHarness({ api, userId: 'user-a', threadId: null });
	const { result } = renderAttachments(harness);

	act(() => {
		result.current.add([textFile()]);
	});
	await flushUploadStart();
	const localId = result.current.items[0]?.localId;
	expect(localId).toBeDefined();

	// The account changes and the attachment is gone before the upload lands.
	harness.context = { api, userId: 'user-b', threadId: null };
	act(() => {
		result.current.remove(localId!);
	});
	await act(async () => {
		pending[0].resolve({
			storageId: 'storage-9' as Id<'_storage'>,
			name: 'notes.txt',
			mediaType: 'text/plain',
			size: 8,
			url: 'blob:local'
		});
	});

	expect(discards).toEqual([{ userId: 'user-a', storageId: 'storage-9' }]);
	expect(result.current.items).toEqual([]);
});

it('keeps one stable instance across renders and notifies subscribers on change', () => {
	const { api } = createDesktopApi();
	const harness = attachmentHarness({ api, userId: 'user-a', threadId: null });
	const { result, rerender } = renderAttachments(harness);
	const instance = result.current;
	const listener = vi.fn();
	const unsubscribe = instance.subscribe(listener);
	const before = instance.getSnapshot();

	rerender();
	expect(result.current).toBe(instance);

	act(() => {
		instance.replace([
			{ localId: 'local-1', name: 'notes.txt', mediaType: 'text/plain', size: 8, status: 'ready' }
		]);
	});
	expect(listener).toHaveBeenCalledTimes(1);
	expect(instance.getSnapshot()).not.toBe(before);
	unsubscribe();
});

it('reports upload failures through onError', async () => {
	const { api } = createDesktopApi({ uploadFails: new Error('Gateway rejected the upload.') });
	const onError = vi.fn();
	const harness = attachmentHarness({ api, userId: 'user-a', threadId: null }, onError);
	const { result } = renderAttachments(harness);

	act(() => {
		result.current.add([textFile()]);
	});
	await flushUploadStart();

	expect(onError).toHaveBeenCalledWith('Gateway rejected the upload.');
	expect(result.current.items[0]?.status).toBe('error');
	expect(result.current.items[0]?.error).toBe('Gateway rejected the upload.');
});
