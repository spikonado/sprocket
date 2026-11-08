import type { BoardScene } from '$lib/kicad-frame/board-3d-scene';
import type { EcadViewerElement } from '$lib/kicad-frame/ecad-viewer';

const STYLE = `
:host { display: block; position: relative; width: 100%; height: 100%; background: var(--background); }
.scene { position: absolute; inset: 0; }
.status { position: absolute; color: var(--muted-foreground); font: 13px/1.5 var(--font-sans); text-align: center; }
.status.blank { inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; }
.status.pill { bottom: 12px; left: 50%; transform: translateX(-50%); max-width: 80%; overflow: hidden;
	text-overflow: ellipsis; white-space: nowrap; padding: 6px 12px; font-size: 12px; border-radius: 6px;
	border: 1px solid var(--border); background: color-mix(in oklab, var(--background) 80%, transparent); }
`;

/**
 * Shows KiCad's own glTF export in the viewer's 3D tab, so copper, mask, silkscreen and
 * component models match KiCad's 3D viewer. The viewer creates `<ecad-3d-viewer>` the first
 * time its 3D tab opens. Exports take seconds, so this exports only while the tab shows and
 * only for a board version it hasn't shown.
 */
export function createBoard3d(
	viewer: EcadViewerElement,
	requestModel: (boardVersion: string) => void
) {
	let element: HTMLElement | null = null;
	let status: HTMLElement | null = null;
	let scene: Promise<BoardScene> | null = null;
	let boardVersion: string | null = null;
	let shownVersion: string | null = null;
	let pendingVersion: string | null = null;
	let failedVersion: string | null = null;

	const setStatus = (text: string | null) => {
		if (!status) return;
		status.hidden = !text;
		status.textContent = text;
		status.className = shownVersion ? 'status pill' : 'status blank';
		status.role = failedVersion ? 'alert' : 'status';
	};

	const refresh = () => {
		if (!element?.checkVisibility() || !boardVersion) return;

		if ([shownVersion, pendingVersion, failedVersion].includes(boardVersion)) return;
		pendingVersion = boardVersion;
		setStatus(shownVersion ? 'Updating…' : 'Building the 3D model with KiCad…');
		requestModel(boardVersion);
	};

	const attach = (host: HTMLElement, root: ShadowRoot) => {
		const container = document.createElement('div');

		container.className = 'scene';
		status = document.createElement('div');
		root.replaceChildren(Object.assign(document.createElement('style'), { textContent: STYLE }));
		root.append(container, status);
		element = host;
		scene = import('$lib/kicad-frame/board-3d-scene').then((module) =>
			module.createBoardScene(container)
		);

		// The viewer hides this element behind its own spinner until the project reports a
		// model. This element shows its own progress instead, and the viewer listens only after
		// connecting it.
		queueMicrotask(() => viewer.project.dispatchEvent(new Event('3d:viewer:loaded')));
	};

	class Board3dElement extends HTMLElement {
		connectedCallback() {
			attach(this, this.shadowRoot ?? this.attachShadow({ mode: 'open' }));
		}

		disconnectedCallback() {
			void scene?.then((current) => current.dispose());
			element = status = scene = null;
			shownVersion = pendingVersion = failedVersion = null;
		}

		/** Called by the viewer each time its 3D tab opens. */
		on_show() {
			// Opening the tab again retries a failed export.
			failedVersion = null;
			refresh();
		}
	}

	customElements.define('ecad-3d-viewer', Board3dElement);

	return {
		setBoardVersion(version: string | null) {
			boardVersion = version;
			refresh();
		},
		async show(version: string, glb: ArrayBuffer) {
			if (version !== pendingVersion || !scene) return;

			try {
				await (await scene).show(glb);
				shownVersion = version;
				setStatus(null);
			} catch (error) {
				failedVersion = version;
				setStatus(error instanceof Error ? error.message : 'Could not show the board in 3D.');
			}

			pendingVersion = null;
			refresh();
		},
		fail(version: string, message: string) {
			if (version !== pendingVersion) return;
			pendingVersion = null;
			failedVersion = version;
			setStatus(message);
		}
	};
}
