import { render, waitFor } from '@testing-library/react';
import { EditorView } from 'codemirror';
import { expect, it, vi } from 'vitest';
import type { FileDraft } from '$lib/chat/side-panel';
import FileEditor, { type FileEditorApi } from './file-editor';

const file = { workspacePath: '/repo', path: 'notes.txt' };

function editorView() {
	return EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
}

it('reopens with the draft it reported, before the file is read again', async () => {
	const api: FileEditorApi = {
		readWorkspaceFile: vi.fn(async () => ({
			content: 'saved',
			version: 'v1',
			size: 5,
			unsupported: null
		})),
		writeWorkspaceFile: vi.fn()
	};

	let draft: FileDraft | undefined;

	const props = {
		api,
		file,
		active: false,
		onDraftChange: (next: FileDraft | undefined) => {
			draft = next;
		}
	};

	const first = render(<FileEditor {...props} draft={undefined} />);

	await waitFor(() => expect(editorView().state.doc.toString()).toBe('saved'));
	editorView().dispatch({ changes: { from: 5, insert: ' and edited' } });
	first.unmount();

	vi.mocked(api.readWorkspaceFile).mockReturnValue(new Promise(() => {}));
	render(<FileEditor {...props} draft={draft} />);

	expect(editorView().state.doc.toString()).toBe('saved and edited');
});
