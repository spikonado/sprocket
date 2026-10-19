import { render, waitFor } from '@testing-library/react';
import { EditorView } from 'codemirror';
import { expect, it, vi } from 'vitest';
import FileEditor, { type FileEditorApi } from './file-editor';

const file = { workspacePath: '/repo', path: 'notes.txt' };

function editorApi(): FileEditorApi {
	return {
		readWorkspaceFile: vi.fn(async () => ({
			content: 'saved',
			version: 'v1',
			size: 5,
			unsupported: null
		})),
		writeWorkspaceFile: vi.fn()
	};
}

function editorView() {
	return EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
}

it('restores unsaved edits after the editor remounts', async () => {
	const api = editorApi();
	const onDirtyChange = vi.fn();
	const props = { api, file, draftKey: 'tab-1', active: false, onDirtyChange };
	const first = render(<FileEditor {...props} />);

	await waitFor(() => expect(editorView().state.doc.toString()).toBe('saved'));
	editorView().dispatch({ changes: { from: 5, insert: ' and edited' } });
	first.unmount();

	onDirtyChange.mockClear();
	render(<FileEditor {...props} />);

	await waitFor(() => expect(editorView().state.doc.toString()).toBe('saved and edited'));
	await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
});
