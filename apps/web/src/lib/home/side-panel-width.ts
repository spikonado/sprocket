import { useEffect, useState } from 'react';

const DEFAULT_WIDTH = 320;

const STORAGE_KEY = 'sprocket.side-panel.width';

function readWidth() {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		const width = stored === null ? DEFAULT_WIDTH : Number(stored);

		return Number.isFinite(width) && width >= DEFAULT_WIDTH ? width : DEFAULT_WIDTH;
	} catch {
		return DEFAULT_WIDTH;
	}
}

export function useSidePanelWidth(viewportWidth: number, sidebarVisible: boolean) {
	const [preferredWidth, setPreferredWidth] = useState(readWidth);
	const viewport = viewportWidth || DEFAULT_WIDTH;
	const sidebarWidth = sidebarVisible && viewport >= 768 ? 260 : 0;
	const maxWidth = Math.min(viewport, Math.max(DEFAULT_WIDTH, viewport - sidebarWidth - 360));
	const minWidth = Math.min(DEFAULT_WIDTH, maxWidth);
	const width = Math.min(preferredWidth, maxWidth);

	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, String(preferredWidth));
		} catch {
			// Resizing still works when browser storage is unavailable.
		}
	}, [preferredWidth]);

	return {
		width,
		minWidth,
		maxWidth,
		setWidth: (next: number) => setPreferredWidth(Math.max(DEFAULT_WIDTH, Math.min(maxWidth, next)))
	};
}
