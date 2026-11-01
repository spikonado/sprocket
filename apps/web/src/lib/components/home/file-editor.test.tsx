import { act, render, waitFor } from '@testing-library/react';
import { EditorView } from 'codemirror';
import { expect, it, vi } from 'vitest';
import type { FileDraft } from '$lib/chat/side-panel';
import type { DiskEvent, WorkspaceFileContent } from '$lib/types/sprocket';
import FileEditor, { type FileEditorApi } from './file-editor';

const file = { workspacePath: '/repo', path: 'notes.txt' };

const saved: WorkspaceFileContent = { content: 'saved', version: 'v1', size: 5, unsupported: null };

function editorView() {
	return EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
}

function editorApi(onDisk: WorkspaceFileContent | null) {
	let push: (event: DiskEvent<WorkspaceFileContent>) => void = () => {};

	const api: FileEditorApi = {
		watchWorkspaceFile: vi.fn(async (_input, { onEvent, signal }) => {
			// Like the socket, an aborted subscription delivers nothing.
			push = (event) => {
				if (!signal.aborted) onEvent(event);
			};

			if (onDisk) onEvent({ kind: 'snapshot', ...onDisk });
			await new Promise((resolve) => signal.addEventListener('abort', resolve));
		}),
		writeWorkspaceFile: vi.fn(),
		readWorkspaceText: vi.fn()
	};

	return {
		api,
		push: (event: DiskEvent<WorkspaceFileContent>) => act(() => push(event)),
		subscription: () => {
			const current = push;

			return (event: DiskEvent<WorkspaceFileContent>) => act(() => current(event));
		},
		write: (content: WorkspaceFileContent) => {
			onDisk = content;
		}
	};
}

it('reopens with the draft it reported, before the file is read again', async () => {
	let draft: FileDraft | undefined;

	const props = {
		file,
		active: true,
		onDraftChange: (next: FileDraft | undefined) => {
			draft = next;
		}
	};

	const first = render(<FileEditor {...props} api={editorApi(saved).api} draft={undefined} />);

	await waitFor(() => expect(editorView().state.doc.toString()).toBe('saved'));
	editorView().dispatch({ changes: { from: 5, insert: ' and edited' } });
	first.unmount();

	render(<FileEditor {...props} api={editorApi(null).api} draft={draft} />);

	expect(editorView().state.doc.toString()).toBe('saved and edited');
});

it('follows disk changes until there are unsaved edits, then offers a reload', async () => {
	const { api, push } = editorApi(saved);
	render(<FileEditor api={api} file={file} draft={undefined} active onDraftChange={vi.fn()} />);

	await waitFor(() => expect(editorView().state.doc.toString()).toBe('saved'));
	push({ kind: 'snapshot', ...saved, content: 'outside', version: 'v2' });
	expect(editorView().state.doc.toString()).toBe('outside');

	editorView().dispatch({ changes: { from: 0, insert: 'mine ' } });
	push({ kind: 'snapshot', ...saved, content: 'again', version: 'v3' });
	expect(editorView().state.doc.toString()).toBe('mine outside');

	act(() => document.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
	expect(editorView().state.doc.toString()).toBe('again');
});

it('ignores snapshots during a save and watches again once it settles', async () => {
	const { api, push, subscription, write } = editorApi(saved);
	let finishWrite: (result: { status: 'saved'; version: string }) => void = () => {};

	vi.mocked(api.writeWorkspaceFile).mockReturnValue(
		new Promise((resolve) => {
			finishWrite = resolve;
		})
	);
	render(<FileEditor api={api} file={file} draft={undefined} active onDraftChange={vi.fn()} />);

	await waitFor(() => expect(editorView().state.doc.toString()).toBe('saved'));
	editorView().dispatch({ changes: { from: 5, insert: '!' } });
	act(() => {
		editorView().contentDOM.dispatchEvent(
			new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })
		);
	});
	expect(api.writeWorkspaceFile).toHaveBeenCalled();
	const beforeSave = subscription();
	push({ kind: 'snapshot', ...saved, content: 'older', version: 'v0' });
	expect(document.querySelector('[role="alert"]')).toBeNull();

	write({ ...saved, content: 'saved!', version: 'v2' });
	await act(async () => finishWrite({ status: 'saved', version: 'v2' }));
	beforeSave({ kind: 'snapshot', ...saved });

	expect(editorView().state.doc.toString()).toBe('saved!');
	expect(api.watchWorkspaceFile).toHaveBeenCalledTimes(2);
});

it('keeps a failed save error after the file is read again', async () => {
	const { api } = editorApi(saved);
	vi.mocked(api.writeWorkspaceFile).mockRejectedValue(new Error('Disk full'));
	render(<FileEditor api={api} file={file} draft={undefined} active onDraftChange={vi.fn()} />);

	await waitFor(() => expect(editorView().state.doc.toString()).toBe('saved'));
	editorView().dispatch({ changes: { from: 5, insert: '!' } });
	await act(async () => {
		editorView().contentDOM.dispatchEvent(
			new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })
		);
	});

	expect(api.watchWorkspaceFile).toHaveBeenCalledTimes(2);
	expect(document.querySelector('[role="alert"]')?.textContent).toBe('Disk full');
});
