import type { FileEditorApi } from '$lib/components/home/file-editor';
import type { FilesApi } from '$lib/components/home/files-view';
import type { KicanvasViewerApi } from '$lib/components/home/kicanvas-viewer';
import type { LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

export type WorkspaceFiles = Record<string, () => Promise<string>>;

const READ_ONLY = 'This preview is read-only.';

const readOnly = async () => {
	throw new Error(READ_ONLY);
};

function untilAborted(signal: AbortSignal) {
	return new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

function parentDirectories(path: string) {
	const parts = path.split('/').slice(0, -1);

	return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** A read-only project folder served from memory with the local server's file API shape. */
export function workspaceApi(
	files: WorkspaceFiles
): FilesApi & FileEditorApi & KicanvasViewerApi & Pick<LocalApi, 'workspaceEntryKind'> {
	const paths = Object.keys(files).sort();
	const directories = [...new Set(paths.flatMap(parentDirectories))].sort();
	const contents = new Map<string, Promise<string>>();

	const read = ({ path }: WorkspaceFileTarget) => {
		const load = files[path];

		if (load === undefined) return Promise.reject(new Error(`${path} does not exist.`));

		let content = contents.get(path);

		if (!content) {
			content = load();
			contents.set(path, content);
		}

		return content.then((text) => ({ content: text, version: '1' }));
	};

	return {
		watchWorkspaceFiles: async (_input, { onEvent, signal }) => {
			onEvent({
				kind: 'snapshot',
				directories,
				files: paths,
				gitStatus: [],
				scanning: false,
				truncated: false
			});
			await untilAborted(signal);
		},
		watchWorkspaceFile: async (target, { onEvent, signal }) => {
			try {
				const { content, version } = await read(target);
				onEvent({ kind: 'snapshot', content, version, size: content.length, unsupported: null });
			} catch (error) {
				onEvent({ kind: 'error', message: error instanceof Error ? error.message : READ_ONLY });
			}

			await untilAborted(signal);
		},
		readWorkspaceText: (target) => read(target),
		workspaceEntryKind: async ({ path }) => {
			if (path in files) return 'file';

			if (path === '' || directories.includes(path)) return 'directory';

			throw new Error(`${path} does not exist.`);
		},
		writeWorkspaceFile: readOnly,
		createWorkspaceFile: readOnly,
		renameWorkspaceFile: readOnly,
		deleteWorkspaceFile: readOnly,
		kicadScene: readOnly,
		kicadModels: readOnly
	};
}
