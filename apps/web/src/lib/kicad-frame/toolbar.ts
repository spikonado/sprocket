import {
	eventDetail,
	type EcadViewerElement,
	type Tab,
	tabChangeSchema
} from '$lib/kicad-frame/ecad-viewer';

function button(label: string, title: string, onClick: () => void) {
	const element = document.createElement('button');

	element.type = 'button';
	element.textContent = label;
	element.title = title;
	element.addEventListener('click', onClick);

	return element;
}

/** Buttons for the viewer's tools, which it otherwise offers only through shortcuts. */
export function createToolbar(viewer: EcadViewerElement) {
	const bar = document.createElement('div');
	let tab: Tab | null = null;
	let insetsLinked = false;

	const nets = button('', 'Clear the highlighted nets (Esc)', () => {
		viewer.setHighlightedNets([]);
		update();
	});

	const insets = button('Insets', 'Preview the other document on hover (I)', () =>
		viewer.setInsetMode(!viewer.insetMode)
	);

	const measure = button('Measure', 'Measure between two points (Ctrl+Shift+M)', () =>
		viewer.setMeasureMode(!viewer.measureMode)
	);

	const update = () => {
		const count = viewer.getHighlightedNets().length;
		const both = viewer.has_sch && viewer.has_pcb;

		// Insets open the peer's document; this one element holds both documents, so it is its own peer.
		if (both && !insetsLinked) {
			viewer.setInsetPeer(viewer);
			insetsLinked = true;
		}

		nets.hidden = tab !== 'PCB' || count === 0;
		nets.textContent = `${count} ${count === 1 ? 'net' : 'nets'} highlighted ✕`;
		insets.hidden = !both || (tab !== 'SCH' && tab !== 'PCB');
		insets.ariaPressed = String(viewer.insetMode);
		measure.hidden = tab !== 'PCB';
		measure.ariaPressed = String(viewer.measureMode);
		bar.hidden = [nets, insets, measure].every((item) => item.hidden);
	};

	bar.className = 'sprocket-toolbar';
	bar.append(nets, insets, measure);
	document.body.append(bar);

	for (const type of [
		'ecad-viewer:measure-mode',
		'ecad-viewer:inset-mode',
		'ecad-viewer:highlight-change'
	]) {
		viewer.addEventListener(type, update);
	}

	viewer.addEventListener('kicanvas:tab:activate', (event) => {
		tab = eventDetail(event, tabChangeSchema)?.current ?? null;
		update();
	});
	update();

	return { update, tab: () => tab };
}
