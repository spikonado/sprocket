import { useState, type KeyboardEvent, type PointerEvent } from 'react';

type Props = {
	width: number;
	minWidth: number;
	maxWidth: number;
	onWidthChange: (width: number) => void;
};

export default function SidePanelResizeHandle({ width, minWidth, maxWidth, onWidthChange }: Props) {
	const [drag, setDrag] = useState<{
		pointerId: number;
		startX: number;
		startWidth: number;
	} | null>(null);

	function changeWidth(next: number) {
		onWidthChange(Math.max(minWidth, Math.min(maxWidth, next)));
	}

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (event.button !== 0 || drag) return;
		event.preventDefault();
		event.currentTarget.focus();
		event.currentTarget.setPointerCapture(event.pointerId);
		setDrag({ pointerId: event.pointerId, startX: event.clientX, startWidth: width });
	}

	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		if (!drag || event.pointerId !== drag.pointerId) return;
		changeWidth(drag.startWidth + drag.startX - event.clientX);
	}

	function stopDrag(event: PointerEvent<HTMLDivElement>) {
		if (event.pointerId !== drag?.pointerId) return;
		setDrag(null);

		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const step = event.shiftKey ? 64 : 16;
		let next: number;

		if (event.key === 'ArrowLeft') next = width + step;
		else if (event.key === 'ArrowRight') next = width - step;
		else if (event.key === 'Home') next = minWidth;
		else if (event.key === 'End') next = maxWidth;
		else return;
		event.preventDefault();
		changeWidth(next);
	}

	return (
		<>
			{drag && <div className="fixed inset-0 z-40 cursor-col-resize select-none" />}
			<div
				role="separator"
				aria-label="Resize side panel"
				aria-orientation="vertical"
				aria-controls="side-panel"
				aria-valuemin={minWidth}
				aria-valuemax={maxWidth}
				aria-valuenow={width}
				aria-valuetext={`${Math.round(width)} pixels`}
				tabIndex={0}
				title="Drag to resize. Double-click to reset."
				className={`hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:ring-ring absolute inset-y-0 -left-1 z-50 w-2 cursor-col-resize touch-none outline-none select-none focus-visible:ring-2 ${drag ? 'bg-primary/20' : ''}`}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={stopDrag}
				onPointerCancel={stopDrag}
				onLostPointerCapture={stopDrag}
				onKeyDown={onKeyDown}
				onDoubleClick={() => changeWidth(minWidth)}
			/>
		</>
	);
}
