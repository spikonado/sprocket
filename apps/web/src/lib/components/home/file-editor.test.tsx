import { render, waitFor } from '@testing-library/react';
import { runScopeHandlers } from '@codemirror/view';
import { EditorView } from 'codemirror';
import { expect, it, vi } from 'vitest';
import type { WorkspaceFileWriteResult } from '$lib/types/sprocket';
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

it('keeps edits made after a save that finishes once the editor unmounted', async () => {
	const api = editorApi();
	const pendingSave = Promise.withResolvers<WorkspaceFileWriteResult>();

	vi.mocked(api.writeWorkspaceFile).mockReturnValue(pendingSave.promise);
	const props = { api, file, draftKey: 'tab-2', active: false, onDirtyChange: vi.fn() };
	const first = render(<FileEditor {...props} />);

	await waitFor(() => expect(editorView().state.doc.toString()).toBe('saved'));
	editorView().dispatch({ changes: { from: 5, insert: ' once' } });
	runScopeHandlers(
		editorView(),
		new KeyboardEvent('keydown', { key: 's', ctrlKey: true }),
		'editor'
	);
	expect(api.writeWorkspaceFile).toHaveBeenCalledOnce();
	editorView().dispatch({ changes: { from: 10, insert: ' twice' } });
	first.unmount();
	pendingSave.resolve({ status: 'saved', version: 'v2' });

	render(<FileEditor {...props} />);

	await waitFor(() => expect(editorView().state.doc.toString()).toBe('saved once twice'));
});
