import { Box, FlipHorizontal2, Layers, Maximize, X } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import ViewerStatusNotice, { type ViewerStatus } from '$lib/components/home/viewer-status';
import { BoardViewerClient } from '$lib/kicad-viewer/client';
import type { PickResult, View, ViewerLayer } from '$lib/kicad-viewer/protocol';
import type { ItemKind } from '$lib/kicad-viewer/scene';
import type { LocalApi } from '$lib/types/sprocket';
import { useEscapeLayer } from '$lib/use-escape-layer';

const RELOAD_DELAY_MS = 500;

const PANEL = 'bg-background/90 border-hairline rounded-lg border text-xs shadow-sm backdrop-blur';

const ICON_BUTTON =
	'focus-visible:ring-ring text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-full transition focus-visible:ring-2 focus-visible:outline-none';

/**
 * Failed scene loads retry on the next watch snapshot, including after a reconnect.
 * Component exports are slow, so load them only after 3D opens and their key changes.
 */
export default function PcbViewer({
	api,
	workspacePath,
	path,
	snapshot,
	view
}: {
	api: Pick<LocalApi, 'kicadScene' | 'kicadModels'>;
	workspacePath: string;
	path: string;
	snapshot: { version: string } | null;
	view: View | null;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewer = useRef<BoardViewerClient | null>(null);
	const [status, setStatus] = useState<ViewerStatus>({ kind: 'loading' });
	const [status3d, setStatus3d] = useState<ViewerStatus>({ kind: 'ready' });
	const [layers, setLayers] = useState<ViewerLayer[] | null>(null);
	const [modelsKey, setModelsKey] = useState<string | null | undefined>(undefined);
	const [pick, setPick] = useState<PickResult | null>(null);
	const [flipped, setFlipped] = useState<Record<View, boolean>>({ '2d': false, '3d': false });
	const [layersOpen, setLayersOpen] = useState(false);
	const [componentsVisible, setComponentsVisible] = useState(true);
	const [opened3d, setOpened3d] = useState(false);
	const [modelsAttempt, setModelsAttempt] = useState(0);

	const retryModels = useEffectEvent(() => {
		if (view === '3d' && status3d.kind === 'error') setModelsAttempt((attempt) => attempt + 1);
	});

	const loaded = useRef<{ version: string | null; state: 'loading' | 'loaded' | 'failed' }>({
		version: null,
		state: 'loading'
	});

	const latestVersion = useRef(snapshot?.version ?? null);
	const reload = useRef<(retryFailed: boolean) => void>(() => {});
	latestVersion.current = snapshot?.version ?? null;

	useEffect(() => {
		const container = containerRef.current;

		if (!container) return;

		const client = new BoardViewerClient(container, {
			onLoaded: (next, models) => {
				setLayers(next);
				setModelsKey(models);
				setStatus({ kind: 'ready' });
			},
			onPick: setPick,
			onError: (failed, message) =>
				(failed === '3d' ? setStatus3d : setStatus)({ kind: 'error', message }),
			onModels: (error) =>
				setStatus3d(error ? { kind: 'error', message: error } : { kind: 'ready' })
		});

		const closed = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;

		const load = async () => {
			loaded.current = { version: latestVersion.current, state: 'loading' };
			setStatus({ kind: 'loading' });

			try {
				const { scene, version } = await api.kicadScene({ workspacePath, path }, closed.signal);

				if (closed.signal.aborted) return;
				loaded.current.version = version;
				await client.load('scene', scene);
				loaded.current.state = 'loaded';
			} catch (error) {
				if (closed.signal.aborted) return;
				loaded.current.state = 'failed';
				setStatus({
					kind: 'error',
					message: error instanceof Error ? error.message : 'Could not open the board.'
				});
			}

			// The file may have changed again while this load ran.
			reload.current(false);
		};

		reload.current = (retryFailed) => {
			const { version, state } = loaded.current;
			const stale = latestVersion.current !== version || (retryFailed && state === 'failed');

			if (state === 'loading' || !latestVersion.current || !stale) return;
			clearTimeout(timer);
			timer = setTimeout(() => void load(), RELOAD_DELAY_MS);
		};

		viewer.current = client;
		void load();

		return () => {
			closed.abort();
			clearTimeout(timer);
			client.dispose();
			viewer.current = null;
			setModelsKey(undefined);
		};
	}, [api, workspacePath, path]);

	useEffect(() => reload.current(true), [snapshot]);
	useEffect(() => retryModels(), [view, snapshot]);

	useEffect(() => {
		viewer.current?.show(view);

		if (view === '3d') setOpened3d(true);
	}, [api, workspacePath, path, view]);

	useEffect(() => {
		const client = viewer.current;

		if (!client || !opened3d || modelsKey === undefined) return;

		if (modelsKey === null) {
			void client.load('models', null);

			return;
		}

		const controller = new AbortController();
		setStatus3d({ kind: 'loading', message: 'Loading components…' });

		void (async () => {
			try {
				const { models } = await api.kicadModels({ workspacePath, path }, controller.signal);

				if (controller.signal.aborted) return;
				await client.load('models', models);
			} catch (error) {
				if (controller.signal.aborted) return;
				setStatus3d({
					kind: 'error',
					message: error instanceof Error ? error.message : 'Could not load the components.'
				});
			}
		})();

		return () => controller.abort();
	}, [api, workspacePath, path, opened3d, modelsKey, modelsAttempt]);

	useEscapeLayer(() => viewer.current?.clearSelection(), view === '2d' && pick !== null);

	function toggleLayer(name: string, visible: boolean) {
		viewer.current?.setLayerVisible(name, visible);
		setLayers(
			(current) =>
				current && current.map((layer) => (layer.name === name ? { ...layer, visible } : layer))
		);
	}

	function flip(current: View) {
		viewer.current?.flip(current, !flipped[current]);
		setFlipped({ ...flipped, [current]: !flipped[current] });
	}

	function toggleComponents() {
		viewer.current?.setComponentsVisible(!componentsVisible);
		setComponentsVisible(!componentsVisible);
	}

	const shownStatus = view === '3d' && status.kind === 'ready' ? status3d : status;

	return (
		<div
			ref={containerRef}
			className="bg-background absolute inset-0 z-10 overflow-hidden"
			hidden={!view}
			role="region"
			aria-label={`Board viewer for ${path}`}
		>
			{layers && view && (
				<>
					<div className="absolute top-3 right-3 z-10 flex max-h-[calc(100%-1.5rem)] w-44 flex-col items-end gap-2">
						<div
							role="toolbar"
							aria-label="Board tools"
							className="bg-muted flex gap-0.5 rounded-full p-0.5 shadow-sm"
						>
							{view === '2d' ? (
								<ToolButton
									label="Layers"
									pressed={layersOpen}
									onClick={() => setLayersOpen(!layersOpen)}
								>
									<Layers className="size-3.5" aria-hidden="true" />
								</ToolButton>
							) : (
								<ToolButton
									label="Components"
									pressed={componentsVisible}
									onClick={toggleComponents}
								>
									<Box className="size-3.5" aria-hidden="true" />
								</ToolButton>
							)}
							<ToolButton label="Fit board" onClick={() => viewer.current?.fit(view)}>
								<Maximize className="size-3.5" aria-hidden="true" />
							</ToolButton>
							<ToolButton
								label="Flip board"
								title={flipped[view] ? 'Show front' : 'Show back'}
								pressed={flipped[view]}
								onClick={() => flip(view)}
							>
								<FlipHorizontal2 className="size-3.5" aria-hidden="true" />
							</ToolButton>
						</div>
						{view === '2d' && layersOpen && (
							<ul aria-label="Layers" className={`${PANEL} min-h-0 w-full overflow-y-auto p-1`}>
								{layers.map((layer) => (
									<li key={layer.name}>
										<label className="hover:bg-hover-fill flex cursor-pointer items-center gap-2 rounded px-1.5 py-0.5">
											<input
												type="checkbox"
												checked={layer.visible}
												onChange={() => toggleLayer(layer.name, !layer.visible)}
												className="sr-only"
											/>
											<span
												aria-hidden="true"
												className={`size-2.5 shrink-0 rounded-sm transition-opacity ${layer.visible ? '' : 'opacity-25'}`}
												style={{ background: layer.color }}
											/>
											<span
												className={`truncate ${layer.visible ? 'text-foreground' : 'text-muted-foreground'}`}
											>
												{layer.label}
											</span>
										</label>
									</li>
								))}
							</ul>
						)}
					</div>
					{view === '2d' && pick && (
						<Properties pick={pick} onClose={() => viewer.current?.clearSelection()} />
					)}
				</>
			)}
			<ViewerStatusNotice
				status={shownStatus}
				drawn={layers !== null}
				opening="Opening the board…"
			/>
		</div>
	);
}

function ToolButton({
	label,
	title = label,
	pressed,
	onClick,
	children
}: {
	label: string;
	title?: string;
	pressed?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={pressed}
			title={title}
			onClick={onClick}
			className={`${ICON_BUTTON} ${pressed ? 'bg-background text-foreground shadow-sm' : ''}`}
		>
			{children}
			<span className="sr-only">{label}</span>
		</button>
	);
}

function Properties({ pick, onClose }: { pick: PickResult; onClose: () => void }) {
	const { item, parent } = pick;
	const title = item.reference ?? (item.number ? `${kindLabel(item.kind)} ${item.number}` : null);

	const position =
		item.position &&
		`${rounded(item.position[0])}, ${rounded(item.position[1])} mm` +
			(item.position[2] ? ` · ${rounded(item.position[2])}°` : '');

	return (
		<section
			aria-label="Selected item"
			className={`${PANEL} absolute top-12 left-3 z-10 w-60 max-w-[calc(100%-1.5rem)] p-2`}
		>
			<header className="mb-1 flex items-center gap-2">
				<span className="text-muted-foreground">{kindLabel(item.kind)}</span>
				{title && <span className="truncate font-mono">{title}</span>}
				<button type="button" onClick={onClose} className={`${ICON_BUTTON} ml-auto size-5`}>
					<X className="size-3.5" aria-hidden="true" />
					<span className="sr-only">Clear selection</span>
				</button>
			</header>
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
				{parent && (
					<Row
						label={kindLabel(parent.kind)}
						value={[parent.reference, parent.value].filter(Boolean).join(' · ')}
					/>
				)}
				<Row label="Value" value={item.value} />
				<Row label="Text" value={item.text} />
				<Row label="Library" value={item.footprint} />
				<Row label="Net" value={item.net} />
				<Row label="Layer" value={item.layer} />
				<Row label="Position" value={position} />
			</dl>
		</section>
	);
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
	if (!value) return null;

	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="truncate font-mono" title={value}>
				{value}
			</dd>
		</>
	);
}

function rounded(value: number) {
	return String(Number(value.toFixed(3)));
}

function kindLabel(kind: ItemKind) {
	return kind === 'arc' ? 'Arc track' : kind[0].toUpperCase() + kind.slice(1);
}
