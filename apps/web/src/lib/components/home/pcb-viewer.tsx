import { FlipHorizontal2, Layers, Maximize, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ViewerStatusNotice, { type ViewerStatus } from '$lib/components/home/viewer-status';
import { BoardViewerClient } from '$lib/kicad-viewer/client';
import type { PickResult, ViewerLayer } from '$lib/kicad-viewer/protocol';
import type { ItemKind } from '$lib/kicad-viewer/scene';
import type { LocalApi } from '$lib/types/sprocket';
import { useEscapeLayer } from '$lib/use-escape-layer';

const RELOAD_DELAY_MS = 500;

const PANEL = 'bg-background/90 border-hairline rounded-lg border text-xs shadow-sm backdrop-blur';

const ICON_BUTTON =
	'focus-visible:ring-ring text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-full transition focus-visible:ring-2 focus-visible:outline-none';

/**
 * The server parses the board and a worker draws it, so even an 85 MB board leaves the page
 * responsive. A new `snapshot` version from the file watch refetches the scene and keeps the
 * camera. A failed load retries on the next snapshot, which a reconnecting watch sends.
 */
export default function PcbViewer({
	api,
	workspacePath,
	path,
	snapshot,
	shown
}: {
	api: Pick<LocalApi, 'kicadScene'>;
	workspacePath: string;
	path: string;
	snapshot: { version: string } | null;
	shown: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewer = useRef<BoardViewerClient | null>(null);
	const [status, setStatus] = useState<ViewerStatus>({ kind: 'loading' });
	const [layers, setLayers] = useState<ViewerLayer[] | null>(null);
	const [pick, setPick] = useState<PickResult | null>(null);
	const [flipped, setFlipped] = useState(false);
	const [layersOpen, setLayersOpen] = useState(false);

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
			onLoaded: (next) => {
				setLayers(next);
				setStatus({ kind: 'ready' });
			},
			onPick: setPick,
			onError: (message) => setStatus({ kind: 'error', message })
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
				await client.load(scene);
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
		};
	}, [api, workspacePath, path]);

	useEffect(() => reload.current(true), [snapshot]);

	useEscapeLayer(() => viewer.current?.clearSelection(), shown && pick !== null);

	function toggleLayer(name: string, visible: boolean) {
		viewer.current?.setLayerVisible(name, visible);
		setLayers(
			(current) =>
				current && current.map((layer) => (layer.name === name ? { ...layer, visible } : layer))
		);
	}

	function flip() {
		viewer.current?.flip(!flipped);
		setFlipped(!flipped);
	}

	return (
		<div
			ref={containerRef}
			className="absolute inset-0 z-10 overflow-hidden"
			hidden={!shown}
			role="region"
			aria-label={`Board viewer for ${path}`}
		>
			{layers && (
				<>
					<div className="absolute top-3 right-3 z-10 flex max-h-[calc(100%-1.5rem)] w-44 flex-col items-end gap-2">
						<div
							role="toolbar"
							aria-label="Board tools"
							className="bg-muted flex gap-0.5 rounded-full p-0.5 shadow-sm"
						>
							<button
								type="button"
								aria-pressed={layersOpen}
								title="Layers"
								onClick={() => setLayersOpen(!layersOpen)}
								className={`${ICON_BUTTON} ${layersOpen ? 'bg-background text-foreground shadow-sm' : ''}`}
							>
								<Layers className="size-3.5" aria-hidden="true" />
								<span className="sr-only">Layers</span>
							</button>
							<button
								type="button"
								title="Fit board"
								onClick={() => viewer.current?.fit()}
								className={ICON_BUTTON}
							>
								<Maximize className="size-3.5" aria-hidden="true" />
								<span className="sr-only">Fit board</span>
							</button>
							<button
								type="button"
								aria-pressed={flipped}
								title={flipped ? 'Show front' : 'Show back'}
								onClick={flip}
								className={`${ICON_BUTTON} ${flipped ? 'bg-background text-foreground shadow-sm' : ''}`}
							>
								<FlipHorizontal2 className="size-3.5" aria-hidden="true" />
								<span className="sr-only">Flip board</span>
							</button>
						</div>
						{layersOpen && (
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
					{pick && <Properties pick={pick} onClose={() => viewer.current?.clearSelection()} />}
				</>
			)}
			<ViewerStatusNotice status={status} drawn={layers !== null} opening="Opening the board…" />
		</div>
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
