import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import {
	useComposerAttachments,
	type ComposerAttachmentApi,
	type ComposerAttachmentContext
} from '$lib/home/composer-attachments';
import type { TranscriptUploadResult } from '$lib/types/sprocket';

function storageId(value: string): Id<'_storage'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'_storage'>;
}

function uploadResult(storage: string): TranscriptUploadResult {
	return {
		storageId: storageId(storage),
		name: 'notes.txt',
		mediaType: 'text/plain',
		size: 8,
		url: 'blob:local'
	};
}

function renderAttachments(context: ComposerAttachmentContext, onError = vi.fn()) {
	return renderHook(
		(context: ComposerAttachmentContext) =>
			useComposerAttachments({
				context,
				onError,
				localServerRequiredMessage: 'Connect to a running Sprocket server to use this project.'
			}),
		{ initialProps: context }
	);
}

function textFile(name = 'notes.txt') {
	return new File(['contents'], name, { type: 'text/plain' });
}

it('uploads with the context committed when the file is added, not the first render', async () => {
	const gate = Promise.withResolvers<TranscriptUploadResult>();
	const api: ComposerAttachmentApi = {
		uploadTranscriptAttachment: vi.fn(async () => gate.promise),
		discardTranscriptAttachment: vi.fn(async () => true)
	};
	const { result, rerender } = renderAttachments({ api: null, userId: null, threadId: null });

	rerender({ api, userId: 'user-a', threadId: null });
	await act(async () => {
		result.current.add([textFile()]);
	});

	expect(api.uploadTranscriptAttachment).toHaveBeenCalledWith({
		userId: 'user-a',
		name: 'notes.txt',
		file: expect.any(File),
		threadId: undefined
	});

	await act(async () => {
		gate.resolve(uploadResult('storage-1'));
	});
	expect(result.current.items[0]?.status).toBe('ready');
	expect(result.current.items[0]?.storageId).toBe('storage-1');
});

it('reports an unavailable server when the context is still the unconnected one', async () => {
	const onError = vi.fn();
	const { result } = renderAttachments({ api: null, userId: null, threadId: null }, onError);

	await act(async () => {
		result.current.add([textFile()]);
	});

	expect(onError).toHaveBeenCalledWith('Connect to a running Sprocket server to use this project.');
	expect(result.current.items[0]?.status).toBe('error');
});

it('discards a late upload under the account that owned it, not the current one', async () => {
	const gate = Promise.withResolvers<TranscriptUploadResult>();
	const api: ComposerAttachmentApi = {
		uploadTranscriptAttachment: vi.fn(async () => gate.promise),
		discardTranscriptAttachment: vi.fn(async () => true)
	};
	const { result, rerender } = renderAttachments({ api, userId: 'user-a', threadId: null });

	await act(async () => {
		result.current.add([textFile()]);
	});
	const { localId } = result.current.items[0];

	rerender({ api, userId: 'user-b', threadId: null });
	act(() => {
		result.current.remove(localId);
	});
	await act(async () => {
		gate.resolve(uploadResult('storage-9'));
	});

	expect(api.discardTranscriptAttachment).toHaveBeenCalledWith({
		userId: 'user-a',
		storageId: storageId('storage-9'),
		threadId: undefined
	});
	expect(result.current.items).toEqual([]);
});

it('keeps one stable instance across renders and notifies subscribers on change', () => {
	const api: ComposerAttachmentApi = {
		uploadTranscriptAttachment: vi.fn(),
		discardTranscriptAttachment: vi.fn(async () => true)
	};
	const { result, rerender } = renderAttachments({ api, userId: 'user-a', threadId: null });
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

it('reports a pending upload failure through the latest committed onError', async () => {
	const gate = Promise.withResolvers<TranscriptUploadResult>();
	const api: ComposerAttachmentApi = {
		uploadTranscriptAttachment: vi.fn(async () => gate.promise),
		discardTranscriptAttachment: vi.fn(async () => true)
	};
	const context = { api, userId: 'user-a', threadId: null };
	const previousOnError = vi.fn();
	const { result, rerender } = renderHook(
		(onError) =>
			useComposerAttachments({ context, onError, localServerRequiredMessage: 'Connect a server.' }),
		{ initialProps: previousOnError }
	);
	await act(async () => {
		result.current.add([textFile()]);
	});
	const onError = vi.fn();
	rerender(onError);
	await act(async () => {
		gate.reject(new Error('Gateway rejected the upload.'));
	});

	expect(onError).toHaveBeenCalledWith('Gateway rejected the upload.');
	expect(result.current.items[0]?.status).toBe('error');
	expect(result.current.items[0]?.error).toBe('Gateway rejected the upload.');
});
