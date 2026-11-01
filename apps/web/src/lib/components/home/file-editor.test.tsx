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

function editorApi(first: WorkspaceFileContent | null) {
	let push: (event: DiskEvent<WorkspaceFileContent>) => void = () => {};

	const api: FileEditorApi = {
		watchWorkspaceFile: vi.fn(async (_input, { onEvent, signal }) => {
			push = onEvent;

			if (first) onEvent({ kind: 'snapshot', ...first });
			await new Promise((resolve) => signal.addEventListener('abort', resolve));
		}),
		writeWorkspaceFile: vi.fn()
	};

	return { api, push: (event: DiskEvent<WorkspaceFileContent>) => act(() => push(event)) };
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
