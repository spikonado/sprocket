import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { FILE_TOO_LARGE_MESSAGE, MAX_FILE_BYTES } from '@convex/lib/fileLimits';
import {
	useComposerAttachments,
	type ComposerAttachmentApi,
	type ComposerAttachmentContext
} from '$lib/home/composer-attachments';
import type { TranscriptUploadResult } from '$lib/types/sprocket';
import { fixtureId } from '$lib/convex-test-client';

const fileId = fixtureId<'files'>;

function uploadResult(file: string): TranscriptUploadResult {
	return {
		fileId: fileId(file),
		name: 'notes.txt',
		mediaType: 'text/plain',
		size: 8
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
		gate.resolve(uploadResult('file-1'));
	});
	expect(result.current.items[0]?.status).toBe('ready');
	expect(result.current.items[0]?.fileId).toBe('file-1');
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

it('rejects files over the upload limit without sending them to the server', async () => {
	const api: ComposerAttachmentApi = {
		uploadTranscriptAttachment: vi.fn(),
		discardTranscriptAttachment: vi.fn()
	};

	const file = textFile();
	Object.defineProperty(file, 'size', { value: MAX_FILE_BYTES + 1 });
	const { result } = renderAttachments({ api, userId: 'user-a', threadId: null });

	await act(async () => {
		result.current.add([file]);
	});

	expect(api.uploadTranscriptAttachment).not.toHaveBeenCalled();
	expect(result.current.items[0]).toMatchObject({
		status: 'error',
		error: FILE_TOO_LARGE_MESSAGE
	});
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
		gate.resolve(uploadResult('file-9'));
	});

	expect(api.discardTranscriptAttachment).toHaveBeenCalledWith({
		userId: 'user-a',
		fileId: fileId('file-9'),
		threadId: undefined
	});
	expect(result.current.items).toEqual([]);
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
