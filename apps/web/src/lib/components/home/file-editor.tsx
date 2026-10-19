import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { basicSetup, EditorView } from 'codemirror';
import { useEffect, useRef, useState } from 'react';
import { markdownImageUrl } from '$lib/chat/markdown-images';
import type { DesktopApi, WorkspaceFileContent, WorkspaceFileTarget } from '$lib/types/sprocket';

export type FileEditorApi = Pick<DesktopApi, 'readWorkspaceFile' | 'writeWorkspaceFile'>;

type Props = {
	api: FileEditorApi | null;
	file: WorkspaceFileTarget;
	/** Identifies the tab so unsaved edits survive the editor unmounting. */
	draftKey: string;
	/** Polls the file for outside edits while the tab is visible. */
	active: boolean;
	onDirtyChange: (dirty: boolean) => void;
};

type Status =
	| { kind: 'loading' }
	| { kind: 'text' }
	| { kind: 'unsupported'; message: string }
	| { kind: 'error'; message: string };

const DISK_POLL_MS = 2_500;

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i;

type Draft = { doc: Text; base: Text; version: string };

/** Unsaved buffers by tab, kept while the panel is closed or another view replaces it. */
const drafts = new Map<string, Draft>();

export function discardFileDraft(draftKey: string) {
	drafts.delete(draftKey);
}

if (typeof window !== 'undefined') {
	window.addEventListener('beforeunload', (event) => {
		if (drafts.size > 0) event.preventDefault();
	});
}

const editorTheme = EditorView.theme({
	'&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--background)' },
	'.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
	'.cm-content': { caretColor: 'var(--foreground)' },
	'.cm-gutters': {
		backgroundColor: 'var(--background)',
		color: 'var(--muted-foreground)',
		border: 'none'
	},
	'.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--hover-fill)' },
	'&.cm-focused': { outline: 'none' },
	'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
		backgroundColor: 'var(--selection)'
	},
	'.cm-cursor': { borderLeftColor: 'var(--foreground)' },
	'.cm-panels': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' },
	'.cm-tooltip': {
		backgroundColor: 'var(--surface)',
		border: '1px solid var(--hairline)',
		borderRadius: '6px'
	}
});

function basename(path: string) {
	return path.slice(path.lastIndexOf('/') + 1);
}

export default function FileEditor(props: Props) {
	return IMAGE_EXTENSIONS.test(props.file.path) ? (
		<ImagePreview file={props.file} />
	) : (
		<TextFileEditor {...props} />
	);
}

function ImagePreview({ file }: { file: WorkspaceFileTarget }) {
	// Encoded so `#`, `?`, and `%` in filenames survive the Markdown URL parsing.
	const source = file.path.split('/').map(encodeURIComponent).join('/');
	const src = markdownImageUrl(source, { workspacePath: file.workspacePath });

	return (
		<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
			{src ? <img src={src} alt={basename(file.path)} className="max-h-full max-w-full" /> : null}
		</div>
	);
}

function TextFileEditor({ api, file, draftKey, active, onDirtyChange }: Props) {
	const [status, setStatus] = useState<Status>({ kind: 'loading' });
	const [dirty, setDirty] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	/** Disk version the buffer has not absorbed because it has unsaved edits. */
	const [diskVersion, setDiskVersion] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const savedDoc = useRef<Text | null>(null);
	const version = useRef<string | null>(null);
	const generation = useRef(0);
	const language = useRef(new Compartment());
	const latest = useRef({ api, file });
	latest.current = { api, file };

	const actions = useRef<{ save: (overwrite: boolean) => void; sync: (force: boolean) => void }>({
		save: () => {},
		sync: () => {}
	});

	function markDirty() {
		const view = viewRef.current;
		const base = savedDoc.current;
		const isDirty = !!view && !!base && !view.state.doc.eq(base);

		if (isDirty && version.current !== null) {
			drafts.set(draftKey, { doc: view.state.doc, base, version: version.current });
		} else {
			drafts.delete(draftKey);
		}

		setDirty(isDirty);
	}

	function extensions(): Extension[] {
		return [
			basicSetup,
			editorTheme,
			syntaxHighlighting(classHighlighter),
			language.current.of([]),
			keymap.of([
				{
					key: 'Mod-s',
					preventDefault: true,
					run: () => {
						actions.current.save(false);

						return true;
					}
				}
			]),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) markDirty();
			})
		];
	}

	function replaceContent(content: string | Text, nextVersion: string, base?: Text) {
		const view = viewRef.current;

		if (!view) return;
		const selection = view.state.selection.main.head;
		view.setState(
			EditorState.create({
				doc: content,
				selection: { anchor: Math.min(selection, content.length) },
				extensions: extensions()
			})
		);
		void loadLanguage(view);
		savedDoc.current = base ?? view.state.doc;
		version.current = nextVersion;
		setDiskVersion(null);
		markDirty();
	}

	async function loadLanguage(view: EditorView) {
		const description = LanguageDescription.matchFilename(
			languages,
			basename(latest.current.file.path)
		);

		const support = description ? await description.load().catch(() => null) : null;

		if (support && viewRef.current === view) {
			view.dispatch({ effects: language.current.reconfigure(support) });
		}
	}

	async function sync(force: boolean) {
		const { api, file } = latest.current;

		if (!api) return;

		const started = ++generation.current;

		let result: WorkspaceFileContent;

		try {
			result = await api.readWorkspaceFile(file);
		} catch (error) {
			if (started !== generation.current) return;

			const message = error instanceof Error ? error.message : 'Could not read the file.';

			if (version.current === null) setStatus({ kind: 'error', message });
			else setNotice(message);

			return;
		}

		if (started !== generation.current) return;

		const draft = version.current === null ? drafts.get(draftKey) : undefined;

		if (draft) {
			replaceContent(draft.doc, draft.version, draft.base);
			setStatus({ kind: 'text' });
		}

		const view = viewRef.current;
		const hasEdits = !!view && !!savedDoc.current && !view.state.doc.eq(savedDoc.current);

		if (result.unsupported) {
			if (hasEdits && !force) {
				setDiskVersion(result.version);

				return;
			}

			setStatus({
				kind: 'unsupported',
				message:
					result.unsupported === 'binary'
						? 'This file is binary and can’t be shown as text.'
						: `This file is too large to edit here (${(result.size / 1024 / 1024).toFixed(1)} MB).`
			});

			return;
		}

		setStatus({ kind: 'text' });
		setNotice(null);

		if (result.version === version.current) {
			setDiskVersion(null);

			return;
		}

		if (hasEdits && !force) setDiskVersion(result.version);
		else replaceContent(result.content ?? '', result.version);
	}

	async function save(overwrite: boolean) {
		const { api, file } = latest.current;
		const view = viewRef.current;

		if (!api || !view || version.current === null) return;

		const doc = view.state.doc;

		generation.current++;

		try {
			const result = await api.writeWorkspaceFile({
				...file,
				content: doc.toString(),
				expectedVersion: overwrite ? null : version.current
			});

			if (result.status === 'conflict') {
				setDiskVersion(result.version);

				return;
			}

			// Reads that overlapped the write may carry the old content.
			generation.current++;
			savedDoc.current = doc;
			version.current = result.version;
			setDiskVersion(null);
			setNotice(null);
			markDirty();
		} catch (error) {
			setNotice(error instanceof Error ? error.message : 'Could not save the file.');
		}
	}

	actions.current = {
		save: (overwrite) => void save(overwrite),
		sync: (force) => void sync(force)
	};

	useEffect(() => {
		if (!containerRef.current) return;

		const view = new EditorView({ parent: containerRef.current });

		viewRef.current = view;

		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, []);

	useEffect(() => {
		actions.current.sync(false);

		if (viewRef.current) void loadLanguage(viewRef.current);
	}, [file.workspacePath, file.path]);

	useEffect(() => {
		if (!active) return;

		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') actions.current.sync(false);
		}, DISK_POLL_MS);

		return () => clearInterval(timer);
	}, [active]);

	useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{diskVersion !== null ? (
				<div
					role="alert"
					className="border-hairline flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-100"
				>
					<span className="min-w-0 flex-1">This file changed on disk while you were editing.</span>
					<button
						type="button"
						onClick={() => actions.current.sync(true)}
						className="hover:bg-hover-fill shrink-0 rounded px-2 py-0.5 font-medium"
					>
						Reload
					</button>
					<button
						type="button"
						onClick={() => actions.current.save(true)}
						className="hover:bg-hover-fill shrink-0 rounded px-2 py-0.5 font-medium"
					>
						Overwrite
					</button>
				</div>
			) : null}
			{notice ? (
				<p
					role="alert"
					className="border-hairline text-destructive shrink-0 border-b px-3 py-1.5 text-xs"
				>
					{notice}
				</p>
			) : null}
			{status.kind === 'loading' || status.kind === 'error' || status.kind === 'unsupported' ? (
				<p
					role={status.kind === 'error' ? 'alert' : 'status'}
					className="text-muted-foreground p-3 text-sm"
				>
					{status.kind === 'loading' ? 'Loading…' : status.message}
				</p>
			) : null}
			<div
				ref={containerRef}
				hidden={status.kind !== 'text'}
				className="file-editor min-h-0 flex-1 overflow-hidden"
			/>
		</div>
	);
}
