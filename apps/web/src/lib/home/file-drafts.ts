import type { Text } from '@codemirror/state';

export type FileDraft = { doc: Text; base: Text; version: string };

/** Unsaved editor buffers by side panel tab id, kept while the tab's editor is unmounted. */
export const fileDrafts = new Map<string, FileDraft>();

if (typeof window !== 'undefined') {
	window.addEventListener('beforeunload', (event) => {
		if (fileDrafts.size > 0) event.preventDefault();
	});
}
