import { useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import {
	MIN_PANE_SIZE,
	paneSpan,
	type LayoutRect,
	type SidePanelSplit
} from '$lib/chat/side-panel';

type Props = {
	split: SidePanelSplit;
	/** Area the split divides, as fractions of `container`. */
	rect: LayoutRect;
	container: RefObject<HTMLElement | null>;
	onResize: (ratio: number) => void;
};

function percent(value: number) {
	return `${value * 100}%`;
}

export default function SidePanelSplitDivider({ split, rect, container, onResize }: Props) {
	const [dragPointer, setDragPointer] = useState<number | null>(null);
	const row = split.direction === 'row';

	function regionPx() {
		const bounds = container.current!.getBoundingClientRect();

		return row
			? { start: bounds.left + rect.left * bounds.width, size: rect.width * bounds.width }
			: { start: bounds.top + rect.top * bounds.height, size: rect.height * bounds.height };
	}

	/** Keeps every pane nested on either side at least `MIN_PANE_SIZE` along this split. */
	function resize(ratio: number, size = regionPx().size) {
		const min = MIN_PANE_SIZE[split.direction];
		const lowest = (min * paneSpan(split.first, split.direction)) / size;
		const highest = 1 - (min * paneSpan(split.second, split.direction)) / size;

		if (lowest <= highest) onResize(Math.max(lowest, Math.min(highest, ratio)));
	}

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (event.button !== 0 || dragPointer !== null) return;
		event.preventDefault();
		event.currentTarget.focus();
		event.currentTarget.setPointerCapture(event.pointerId);
		setDragPointer(event.pointerId);
	}

	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		if (event.pointerId !== dragPointer) return;
		const { start, size } = regionPx();

		if (size > 0) resize(((row ? event.clientX : event.clientY) - start) / size, size);
	}

	function stopDrag(event: PointerEvent<HTMLDivElement>) {
		if (event.pointerId !== dragPointer) return;
		setDragPointer(null);

		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const step = event.shiftKey ? 0.2 : 0.05;

		if (event.key === (row ? 'ArrowLeft' : 'ArrowUp')) resize(split.ratio - step);
		else if (event.key === (row ? 'ArrowRight' : 'ArrowDown')) resize(split.ratio + step);
		else return;
		event.preventDefault();
	}

	const cursor = row ? 'cursor-col-resize' : 'cursor-row-resize';

	const position = row
		? {
				left: percent(rect.left + rect.width * split.ratio),
				top: percent(rect.top),
				height: percent(rect.height)
			}
		: {
				top: percent(rect.top + rect.height * split.ratio),
				left: percent(rect.left),
				width: percent(rect.width)
			};

	return (
		<>
			{dragPointer !== null && <div className={`fixed inset-0 z-40 select-none ${cursor}`} />}
			<div
				role="separator"
				aria-label={row ? 'Resize panes side by side' : 'Resize stacked panes'}
				aria-orientation={row ? 'vertical' : 'horizontal'}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(split.ratio * 100)}
				tabIndex={0}
				title="Drag to resize. Double-click to even out."
				style={position}
				className={`group absolute z-30 touch-none outline-none select-none ${cursor} ${
					row ? 'w-2 -translate-x-1/2' : 'h-2 -translate-y-1/2'
				}`}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={stopDrag}
				onPointerCancel={stopDrag}
				onLostPointerCapture={stopDrag}
				onKeyDown={onKeyDown}
				onDoubleClick={() => resize(0.5)}
			>
				<div
					className={`absolute transition-colors ${
						row
							? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
							: 'inset-x-0 top-1/2 h-px -translate-y-1/2'
					} ${
						dragPointer === null
							? 'bg-hairline group-hover:bg-ring group-focus-visible:bg-ring group-hover:delay-150'
							: 'bg-ring'
					}`}
				/>
			</div>
		</>
	);
}
