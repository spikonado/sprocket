import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render as renderView, within } from '@testing-library/react';
import type { Id } from '@convex/_generated/dataModel';
import type { TranscriptDisplayDetails } from '$lib/types/sprocket';
import WorkSectionDetails from './work-section-details';

type Props = React.ComponentProps<typeof WorkSectionDetails>;

let intersection: () => void;

let disconnect: ReturnType<typeof vi.fn>;

function page(
	ids: number[],
	previousBefore?: number,
	nextAfter?: number
): TranscriptDisplayDetails {
	return {
		parts: ids.map((id) => ({ type: 'reasoning', id: String(id), text: `Reason ${id}` })),
		previousBefore,
		nextAfter,
		revision: 1,
		indexing: false,
		stale: false
	};
}

function tools(ids: number[], previousBefore?: number): TranscriptDisplayDetails {
	return {
		...page([], previousBefore),
		parts: ids.flatMap((id) => [
			{
				type: 'tool-call' as const,
				callId: String(id),
				name: 'exec_command',
				input: { cmd: `echo ${id}` }
			},
			{ type: 'tool-result' as const, callId: String(id), name: 'exec_command', output: {} }
		])
	};
}

async function settle() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(16);
	});
}

async function render(load: Props['load'], inProgress = false, visible = false) {
	const viewport = document.createElement('div');
	document.body.append(viewport);
	Object.defineProperty(viewport, 'clientHeight', { value: 600 });
	const edges = { older: 3_000, newer: visible ? 300 : 3_000 };
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
		this: HTMLElement
	) {
		if (this === viewport) return new DOMRect(0, 0, 800, 600);
		const edge = this.dataset.workEdge;

		return new DOMRect(0, edge === 'older' ? edges.older : edges.newer, 800, 1);
	});
	const restore = vi.fn();

	const props: Props = {
		row: {
			id: 'work',
			// SAFETY: Fixture IDs never leave the mounted component.
			threadId: 'thread' as Id<'threadRecords'>,
			// SAFETY: Fixture IDs never leave the mounted component.
			runId: 'run' as Id<'runs'>,
			kind: 'work',
			text: '',
			sequence: 1,
			itemCount: 100,
			pendingTools: 0,
			closed: !inProgress,
			revision: 1
		},
		load,
		inProgress,
		viewport,
		beforeChange: vi.fn(() => restore)
	};

	const rendered = renderView(<WorkSectionDetails {...props} />, { container: viewport });
	await settle();

	return {
		viewport,
		props,
		edges,
		restore,
		unmount: rendered.unmount,
		setProps(patch: Partial<Props>) {
			Object.assign(props, patch);
			rendered.rerender(<WorkSectionDetails {...props} />);
		}
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	disconnect = vi.fn();
	vi.stubGlobal(
		'IntersectionObserver',
		class {
			constructor(callback: () => void) {
				intersection = callback;
			}
			observe = vi.fn();
			disconnect = disconnect;
		}
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('scrolling work details', () => {
	it('appends completed work without replacing expanded reasoning', async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce(page([1], undefined, 1))
			.mockResolvedValueOnce(page([2], 2));

		const { viewport, edges, props, restore } = await render(load);
		expect(load.mock.calls[0][1]).toEqual({});
		act(() => within(viewport).getByRole('button', { name: 'Reasoned' }).click());
		const reasoning = within(viewport).getByText('Reason 1');
		edges.newer = 1_500;
		act(() => intersection());
		await settle();
		expect(load.mock.calls[1][1]).toEqual({ after: 1 });
		expect(within(viewport).getByText('Reason 1')).toBe(reasoning);
		expect(viewport.textContent).toContain('Reason 1');
		act(() => within(viewport).getAllByRole('button', { name: 'Reasoned' })[1].click());
		expect(viewport.textContent).toContain('Reason 2');
		expect(viewport.querySelectorAll('[data-work-detail]')).toHaveLength(2);
		expect(viewport.textContent).not.toMatch(/Previous details|Next details/);
		expect(
			viewport.querySelector('[class~="overflow-auto"], [class~="overflow-y-auto"]')
		).toBeNull();
		expect(props.beforeChange).toHaveBeenLastCalledWith(false);
		expect(restore).toHaveBeenCalledTimes(2);
	});

	it('opens active work at the oldest page and preserves inline tool rows as pages arrive', async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce({ ...tools([2, 3]), nextAfter: 3 })
			.mockResolvedValueOnce({ ...tools([4, 5], 4), nextAfter: 5 })
			.mockResolvedValueOnce(tools([6, 7], 6));

		const { viewport, edges, props, setProps } = await render(load, true);
		expect(load.mock.calls[0][1]).toEqual({});
		expect(props.beforeChange).toHaveBeenLastCalledWith(true);

		const originalTool = [...viewport.querySelectorAll('[data-tool-row]')].find((row) =>
			row.textContent?.includes('echo 2')
		);

		expect(originalTool).not.toBeNull();
		expect(viewport.querySelector('button')).toBeNull();
		edges.newer = 1_500;
		act(() => intersection());
		await settle();
		expect(load.mock.calls[1][1]).toEqual({ after: 3 });
		expect(
			[...viewport.querySelectorAll('[data-tool-row]')].find((row) =>
				row.textContent?.includes('echo 2')
			)
		).toBe(originalTool);
		expect(viewport.textContent).toContain('echo 6');
		expect(
			[...viewport.querySelectorAll('[data-tool-row]')].map(
				(item) => item.querySelector('.truncate')?.textContent
			)
		).toEqual(['echo 2', 'echo 3', 'echo 4', 'echo 5', 'echo 6', 'echo 7']);
		expect(props.beforeChange).toHaveBeenLastCalledWith(true);
		load.mockResolvedValue(tools([2, 3, 4, 5, 6, 7]));
		setProps({ row: { ...props.row, revision: 2 } });
		await settle();
		expect(
			[...viewport.querySelectorAll('[data-tool-row]')].find((row) =>
				row.textContent?.includes('echo 2')
			)
		).toBe(originalTool);
		expect(viewport.querySelectorAll('[data-tool-kind]')).toHaveLength(6);
	});

	it('prefetches work three viewports before its unloaded edge becomes visible', async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce(page([1], undefined, 1))
			.mockResolvedValueOnce(page([2], 2));

		const { viewport, edges } = await render(load);
		edges.newer = 2_000;
		act(() => intersection());
		await settle();
		expect(load).toHaveBeenCalledTimes(2);
		expect(viewport.textContent).not.toMatch(/Scroll (up|down)/);
	});

	it('bounds lookahead when loaded details do not make the section taller', async () => {
		let id = 0;

		const load = vi.fn().mockImplementation(async () => {
			id += 1;

			return page([id], id === 1 ? undefined : id, id);
		});

		const { viewport, unmount } = await render(load, false, true);
		expect(load).toHaveBeenCalledTimes(3);
		act(() => intersection());
		await settle();
		expect(load).toHaveBeenCalledTimes(3);
		viewport.scrollTop = 100;
		act(() => {
			viewport.dispatchEvent(new Event('scroll'));
		});
		await settle();
		expect(load).toHaveBeenCalledTimes(5);
		unmount();
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(load.mock.calls[4][2].aborted).toBe(true);
		act(() => {
			viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true }));
		});
		await settle();
		expect(load).toHaveBeenCalledTimes(5);
	});

	it('continues loading live additions at the visible end without disabling bottom-following', async () => {
		const load = vi.fn().mockResolvedValueOnce(page([1]));
		const { props, viewport, setProps } = await render(load, true, true);

		for (let revision = 2; revision <= 5; revision += 1) {
			load
				.mockResolvedValueOnce(
					page(
						Array.from({ length: revision - 1 }, (_, i) => i + 1),
						undefined,
						revision - 1
					)
				)
				.mockResolvedValueOnce(page([revision], revision));
			setProps({ row: { ...props.row, revision } });
			await settle();
			expect(viewport.querySelectorAll('[data-work-detail]')).toHaveLength(revision);
			expect(props.beforeChange).toHaveBeenLastCalledWith(true);
		}
	});

	it('keeps loaded work on an edge failure and retries that edge', async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce(page([1], undefined, 1))
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(page([2], 2));

		const { viewport, edges } = await render(load);
		edges.newer = 1_500;
		act(() => intersection());
		await settle();
		expect(viewport.querySelectorAll('[data-work-detail]')).toHaveLength(1);
		expect(viewport.textContent).toContain('Could not load these details.');
		act(() => {
			[...viewport.querySelectorAll('button')]
				.find((button) => button.textContent === 'Retry')
				?.click();
		});
		await settle();
		expect(load.mock.calls[2][1]).toEqual({ after: 1 });
		expect(viewport.querySelectorAll('[data-work-detail]')).toHaveLength(2);
	});
});
