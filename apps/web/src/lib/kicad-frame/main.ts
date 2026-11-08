import { createBoard3d } from '$lib/kicad-frame/board-3d';
import {
	type Context,
	type EcadViewerElement,
	eventDetail,
	loadErrorEvent,
	type NetRef,
	type Selection,
	selectionSchema
} from '$lib/kicad-frame/ecad-viewer';
import type { FrameMessage, KicadSource, ParentMessage } from '$lib/kicad-frame/protocol';
import { createToolbar } from '$lib/kicad-frame/toolbar';
import { z } from 'zod';
import '$lib/kicad-frame/frame.css';

declare global {
	interface Window {
		ecadParserWorker?: () => Worker;
		ecadGlyphModuleName?: string;
		ecad3dModuleName?: string;
	}
}

const post = (message: FrameMessage) => parent.postMessage(message, '*');

/** The sandbox denies storage, and the viewer keeps its preferences there. */
function installMemoryStorage() {
	for (const name of ['localStorage', 'sessionStorage']) {
		const items = new Map<string, string>();

		const storage: Storage = {
			get length() {
				return items.size;
			},
			key: (index) => [...items.keys()][index] ?? null,
			getItem: (key) => items.get(key) ?? null,
			setItem: (key, value) => void items.set(key, String(value)),
			removeItem: (key) => void items.delete(key),
			clear: () => items.clear()
		};

		Object.defineProperty(window, name, { value: storage });
	}
}

async function loadViewer() {
	const assets = new URL('/ecad-viewer/', location.href);
	// An opaque origin can start only classic workers, and only from blob URLs.
	const worker = await fetch(new URL('parser.worker.js', assets));

	if (!worker.ok) throw new Error(`Could not load the KiCad parser (${worker.status}).`);
	const workerUrl = URL.createObjectURL(await worker.blob());

	window.ecadParserWorker = () => new Worker(workerUrl);
	window.ecadGlyphModuleName = new URL('glyph-full.js', assets).href;
	// The viewer imports this before creating `<ecad-3d-viewer>`, which `createBoard3d` defines.
	window.ecad3dModuleName = 'data:text/javascript,';
	await import(/* @vite-ignore */ new URL('ecad-viewer.js', assets).href);

	const viewer = document.createElement('ecad-viewer');

	// The frame loads every source itself, and owns the highlighted nets.
	viewer.setAttribute('source-mode', 'host');
	document.body.append(viewer);

	return viewer;
}

const otherContext = (context: Context): Context => (context === 'SCH' ? 'PCB' : 'SCH');

/** Shows the selection's footprint or symbol, or else its net, in the other document. */
function crossProbe(viewer: EcadViewerElement, selection: Selection) {
	const { sourceContext, reference, net, netCode } = selection;
	const targetContext = otherContext(sourceContext);

	if (!(targetContext === 'PCB' ? viewer.has_pcb : viewer.has_sch)) return false;

	if (reference) {
		return viewer.requestCrossProbe({
			sourceContext,
			targetContext,
			mode: 'select',
			kind: 'designator',
			value: reference,
			designator: reference
		});
	}

	if (!net) return false;

	return viewer.requestCrossProbe({
		sourceContext,
		targetContext,
		mode: 'select',
		kind: 'net',
		value: net,
		net,
		netCode
	});
}

async function start() {
	installMemoryStorage();

	let viewer: EcadViewerElement;

	try {
		viewer = await loadViewer();
	} catch (error) {
		post({
			type: 'failed',
			revision: null,
			message: error instanceof Error ? error.message : 'Could not load the KiCad viewer.',
			recovered: false
		});

		return;
	}

	const theme = document.head.appendChild(document.createElement('style'));
	const toolbar = createToolbar(viewer);

	const board3d = createBoard3d(viewer, (boardVersion) =>
		post({ type: 'board3dRequest', boardVersion })
	);

	let shown: KicadSource[] | null = null;
	let loads = 0;

	const highlight = (nets: NetRef[]) => {
		viewer.setHighlightedNets(nets);
		toolbar.update();
	};

	// Each call gets its own key, since the viewer skips sources it thinks it already shows.
	// The viewer refits on every load, so a file edit would otherwise lose the user's view.
	const replace = async (sources: KicadSource[]) => {
		const camera = viewer.camera;
		// The viewer reports a file it can't read with this event and still resolves.
		const failures: string[] = [];

		const onError = (event: Event) => {
			failures.push(eventDetail(event, z.string()) ?? 'The viewer could not read these files.');
		};

		addEventListener(loadErrorEvent, onError);

		try {
			await viewer.replaceSources({ revisionKey: String(++loads), sources });
		} finally {
			removeEventListener(loadErrorEvent, onError);
		}

		if (failures.length) throw new Error(failures.join('\n'));

		viewer.camera = camera;
	};

	const load = async (revision: number, sources: KicadSource[], boardVersion: string | null) => {
		try {
			await replace(sources);
		} catch (error) {
			// A newer load replaced this one.
			if (error instanceof DOMException && error.name === 'AbortError') return;

			const recovered =
				!!shown &&
				(await replace(shown).then(
					() => true,
					() => false
				));

			post({
				type: 'failed',
				revision,
				message: error instanceof Error ? error.message : 'The viewer could not read these files.',
				recovered
			});

			return;
		}

		shown = sources;
		board3d.setBoardVersion(boardVersion);
		toolbar.update();
		post({ type: 'loaded', revision });
	};

	viewer.addEventListener('ecad-viewer:selection', (event) => {
		const selection = eventDetail(event, selectionSchema);

		if (!selection) return;

		if (selection.operation !== 'toggle') {
			if (selection.reference) crossProbe(viewer, selection);

			return;
		}

		const { net, netCode } = selection;

		if (!net) return;

		const nets = viewer.getHighlightedNets();
		const others = nets.filter(({ name }) => name !== net);

		highlight(others.length < nets.length ? others : [...nets, { name: net, netCode }]);
	});

	// A double-click, which also opens the other document.
	viewer.addEventListener('ecad-viewer:crossprobe', (event) => {
		const selection = eventDetail(event, selectionSchema);

		if (selection && crossProbe(viewer, selection)) {
			void viewer.showTab(otherContext(selection.sourceContext));
		}
	});

	// Capturing, so an inset this closes doesn't also see the Escape and close the rest.
	addEventListener(
		'keydown',
		(event) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			event.preventDefault();

			if (viewer.escapeInsets() || viewer.escapeMeasure()) return;

			if (viewer.getHighlightedNets().length) highlight([]);
			else viewer.clearSelection();
		},
		{ capture: true }
	);

	addEventListener('message', ({ source, data }: MessageEvent<ParentMessage>) => {
		// The viewer also posts messages to this window.
		if (source !== parent) return;

		switch (data.type) {
			case 'hello':
				post({ type: 'ready' });
				break;
			case 'theme':
				theme.textContent = data.css;
				break;
			case 'sources':
				void load(data.revision, data.sources, data.boardVersion);
				break;
			case 'board3d':
				void board3d.show(data.boardVersion, data.glb);
				break;
			case 'board3dFailed':
				board3d.fail(data.boardVersion, data.message);
		}
	});

	post({ type: 'ready' });
}

void start();
