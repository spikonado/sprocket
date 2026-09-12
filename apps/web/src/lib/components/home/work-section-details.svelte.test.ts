import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import type { Id } from '$convex/_generated/dataModel';
import type { TranscriptDisplayDetails } from '$lib/types/sprocket';
import WorkSectionDetails from './work-section-details.svelte';

let cleanup: (() => Promise<void>) | undefined;
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
	flushSync();
	await tick();
	await vi.advanceTimersByTimeAsync(16);
}

async function render(
	load: ComponentProps<typeof WorkSectionDetails>['load'],
	inProgress = false,
	visible = false
) {
	const viewport = document.createElement('div');
	document.body.append(viewport);
	Object.defineProperty(viewport, 'clientHeight', { value: 600 });
	const edges = { older: false, newer: visible };
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
		this: HTMLElement
	) {
		if (this === viewport) return new DOMRect(0, 0, 800, 600);
		const edge = this.dataset.workEdge;
		return new DOMRect(0, (edge === 'older' ? edges.older : edges.newer) ? 300 : 1000, 800, 1);
	});
	const restore = vi.fn();
	const props = $state<ComponentProps<typeof WorkSectionDetails>>({
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
	});
	const component = mount(WorkSectionDetails, { target: viewport, props });
	cleanup = async () => {
		await unmount(component);
		viewport.remove();
	};
	await settle();
	return { viewport, props, edges, restore };
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

afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('scrolling work details', () => {
	it('appends completed work in the conversation viewport without replacing open reasoning', async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce(page([1], undefined, 1))
			.mockResolvedValueOnce(page([2], 2));
		const { viewport, edges, props, restore } = await render(load);
		expect(load.mock.calls[0][1]).toEqual({});
		const reasoning = viewport.querySelector<HTMLButtonElement>('button');
		reasoning?.click();
		await settle();
		edges.newer = true;
		intersection();
		await settle();
		expect(load.mock.calls[1][1]).toEqual({ after: 1 });
		expect(viewport.querySelector('button')).toBe(reasoning);
		expect(reasoning?.getAttribute('aria-expanded')).toBe('true');
		expect(viewport.textContent).toContain('Reason 1');
		expect(viewport.querySelectorAll('[data-work-detail]')).toHaveLength(2);
		expect(viewport.textContent).not.toMatch(/Previous details|Next details/);
		expect(viewport.querySelector('[class*="overflow"]')).toBeNull();
		expect(props.beforeChange).toHaveBeenLastCalledWith(false);
		expect(restore).toHaveBeenCalledTimes(2);
	});

	it('opens active work at the latest page and preserves a tool group when older calls join it', async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce(tools([6, 7], 6))
			.mockResolvedValueOnce(tools([4, 5], 4))
			.mockResolvedValueOnce(tools([2, 3]));
		const { viewport, edges, props } = await render(load, true);
		expect(load.mock.calls[0][1]).toEqual({ latest: true });
		expect(props.beforeChange).toHaveBeenLastCalledWith(true);
		const group = viewport.querySelector<HTMLButtonElement>('button');
		const originalTool = viewport.querySelector('[title="echo 6"]');
		expect(originalTool).not.toBeNull();
		expect(group?.getAttribute('aria-expanded')).toBe('true');
		edges.older = true;
		viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 }));
		await settle();
		expect(load.mock.calls[1][1]).toEqual({ before: 6 });
		expect(viewport.querySelector('button')).toBe(group);
		expect(group?.getAttribute('aria-expanded')).toBe('true');
		expect(viewport.querySelector('[title="echo 6"]')).toBe(originalTool);
		expect(viewport.textContent).toContain('echo 2');
		expect(props.beforeChange).toHaveBeenLastCalledWith(false);
		group?.click();
		await settle();
		props.row = { ...props.row, revision: 2 };
		load.mockResolvedValue(tools([2, 3, 4, 5, 6, 7]));
		await settle();
		expect(viewport.querySelector('button')).toBe(group);
		expect(group?.getAttribute('aria-expanded')).toBe('false');
	});

	it.each(['wheel', 'touch', 'scroll', 'ArrowDown', 'PageDown', 'End', ' '])(
		'loads the visible edge after %s input',
		async (input) => {
			const load = vi
				.fn()
				.mockResolvedValueOnce(page([1], undefined, 1))
				.mockResolvedValueOnce(page([2], 2));
			const { viewport, edges } = await render(load);
			edges.newer = true;
			if (input === 'wheel') viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }));
			else if (input === 'scroll') {
				viewport.scrollTop = 100;
				viewport.dispatchEvent(new Event('scroll'));
			} else if (input === 'touch') {
				for (const [type, clientY] of [
					['touchstart', 100],
					['touchmove', 90]
				] as const) {
					const event = new Event(type);
					Object.defineProperty(event, 'touches', { value: [{ clientY }] });
					viewport.dispatchEvent(event);
				}
			} else viewport.dispatchEvent(new KeyboardEvent('keydown', { key: input }));
			await settle();
			expect(load).toHaveBeenCalledTimes(2);
		}
	);

	it('caps automatic filling when collapsed details do not make the section taller', async () => {
		let id = 0;
		const load = vi.fn().mockImplementation(async () => {
			id += 1;
			return page([id], id === 1 ? undefined : id, id);
		});
		const { viewport } = await render(load, false, true);
		expect(load).toHaveBeenCalledTimes(3);
		intersection();
		await settle();
		expect(load).toHaveBeenCalledTimes(3);
		viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }));
		await settle();
		expect(load).toHaveBeenCalledTimes(5);
		await cleanup?.();
		cleanup = undefined;
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(load.mock.calls[4][2].aborted).toBe(true);
		viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }));
		await settle();
		expect(load).toHaveBeenCalledTimes(5);
	});

	it('continues loading live additions at the visible end without disabling bottom-following', async () => {
		const load = vi.fn().mockResolvedValueOnce(page([1]));
		const { props, viewport } = await render(load, true, true);
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
			props.row = { ...props.row, revision };
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
		edges.newer = true;
		intersection();
		await settle();
		expect(viewport.querySelectorAll('[data-work-detail]')).toHaveLength(1);
		expect(viewport.textContent).toContain('Could not load these details.');
		[...viewport.querySelectorAll('button')]
			.find((button) => button.textContent === 'Retry')
			?.click();
		await settle();
		expect(load.mock.calls[2][1]).toEqual({ after: 1 });
		expect(viewport.querySelectorAll('[data-work-detail]')).toHaveLength(2);
	});
});
