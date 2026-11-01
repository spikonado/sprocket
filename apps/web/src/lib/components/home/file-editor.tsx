import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { basicSetup, EditorView } from 'codemirror';
import { useEffect, useRef, useState } from 'react';
import { markdownImageUrl } from '$lib/chat/markdown-images';
import { leafName, type FileDraft } from '$lib/chat/side-panel';
import { usePageVisible } from '$lib/page-visibility';
import type { LocalApi, WorkspaceFileContent, WorkspaceFileTarget } from '$lib/types/sprocket';

export type FileEditorApi = Pick<LocalApi, 'watchWorkspaceFile' | 'writeWorkspaceFile'>;

type Props = {
	api: FileEditorApi | null;
	file: WorkspaceFileTarget;
	/** Read on mount; changes are reported through `onDraftChange`. */
	draft: FileDraft | undefined;
	/** Follows outside edits while the tab is visible. */
	active: boolean;
	onDraftChange: (draft: FileDraft | undefined) => void;
};

type Status =
	| { kind: 'loading' }
	| { kind: 'text' }
	| { kind: 'unsupported'; message: string }
	| { kind: 'error'; message: string };

const RECONNECT_MS = 1_000;

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i;

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
			{src ? <img src={src} alt={leafName(file.path)} className="max-h-full max-w-full" /> : null}
		</div>
	);
}

function TextFileEditor({ api, file, draft, active, onDraftChange }: Props) {
	const [status, setStatus] = useState<Status>({ kind: 'loading' });
	const [readError, setReadError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	/** Disk version the buffer has not absorbed because it has unsaved edits. */
	const [diskVersion, setDiskVersion] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const savedDoc = useRef<Text | null>(null);
	const version = useRef<string | null>(null);
	/** The newest disk state, kept so Reload can apply it. */
	const disk = useRef<WorkspaceFileContent | null>(null);
	/** Snapshots arriving mid-save could undo it or the edits made since; `rewatch` re-reads after. */
	const saves = useRef(0);
	/** Starts a fresh watch, so a snapshot read before a save can't arrive after it. */
	const rewatch = useRef(() => {});
	const visible = usePageVisible();
	const language = useRef(new Compartment());
	const latest = useRef({ api, file, onDraftChange });
	latest.current = { api, file, onDraftChange };

	const actions = useRef<{
		save: (overwrite: boolean) => void;
		absorb: (result: WorkspaceFileContent, force: boolean) => void;
		readFailed: (message: string) => void;
		replace: typeof replaceContent;
	}>({ save: () => {}, absorb: () => {}, readFailed: () => {}, replace: () => {} });

	function reportDraft() {
		const view = viewRef.current;
		const base = savedDoc.current;

		// A save can settle after unmount; the tab's draft is newer than this editor then.
		if (!view || !base || version.current === null) return;
		latest.current.onDraftChange(
			view.state.doc.eq(base) ? undefined : { doc: view.state.doc, base, version: version.current }
		);
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
				if (update.docChanged) reportDraft();
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
		reportDraft();
	}

	async function loadLanguage(view: EditorView) {
		const description = LanguageDescription.matchFilename(
			languages,
			leafName(latest.current.file.path)
		);

		const support = description ? await description.load().catch(() => null) : null;

		if (support && viewRef.current === view) {
			view.dispatch({ effects: language.current.reconfigure(support) });
		}
	}

	function readFailed(message: string) {
		if (version.current === null) setStatus({ kind: 'error', message });
		else setReadError(message);
	}

	function absorb(result: WorkspaceFileContent, force: boolean) {
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
		setReadError(null);

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
		saves.current++;

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

			savedDoc.current = doc;
			version.current = result.version;
			setDiskVersion(null);
			setSaveError(null);
			reportDraft();
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : 'Could not save the file.');
		} finally {
			saves.current--;
			rewatch.current();
		}
	}

	actions.current = {
		save: (overwrite) => void save(overwrite),
		absorb,
		readFailed,
		replace: replaceContent
	};

	const initialDraft = useRef(draft);

	useEffect(() => {
		if (!containerRef.current) return;

		const view = new EditorView({ parent: containerRef.current });

		viewRef.current = view;

		if (initialDraft.current) {
			const { doc, version, base } = initialDraft.current;

			actions.current.replace(doc, version, base);
			setStatus({ kind: 'text' });
		}

		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (viewRef.current) void loadLanguage(viewRef.current);
	}, [file.workspacePath, file.path]);

	useEffect(() => {
		if (!api || !active || !visible) return;
		const target = { workspacePath: file.workspacePath, path: file.path };
		let controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;

		async function watch() {
			const current = new AbortController();
			controller = current;

			try {
				await api!.watchWorkspaceFile(target, {
					signal: current.signal,
					onEvent: (event) => {
						if (saves.current > 0) return;

						if (event.kind === 'error') return actions.current.readFailed(event.message);
						disk.current = event;
						actions.current.absorb(event, false);
					}
				});
			} catch (error) {
				if (!current.signal.aborted) {
					actions.current.readFailed(
						error instanceof Error ? error.message : 'Could not read the file.'
					);
				}
			}

			if (!current.signal.aborted) timer = setTimeout(watch, RECONNECT_MS);
		}

		rewatch.current = () => {
			if (saves.current > 0) return;
			controller.abort();
			clearTimeout(timer);
			void watch();
		};

		void watch();

		return () => {
			rewatch.current = () => {};

			controller.abort();
			clearTimeout(timer);
			disk.current = null;
		};
	}, [api, active, visible, file.workspacePath, file.path]);

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
						onClick={() => {
							if (disk.current) actions.current.absorb(disk.current, true);
						}}
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
			{saveError || readError ? (
				<p
					role="alert"
					className="border-hairline text-destructive shrink-0 border-b px-3 py-1.5 text-xs"
				>
					{saveError ?? readError}
				</p>
			) : null}
			{status.kind !== 'text' ? (
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
