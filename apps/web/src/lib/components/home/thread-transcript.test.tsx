import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render, within } from '@testing-library/react';
import type { Id } from '@convex/_generated/dataModel';
import type { JsonValue } from '@convex/lib/json';
import type {
	TranscriptMessage,
	TranscriptDisplayDetails,
	TranscriptDisplayRow,
	LiveTranscriptMessage
} from '$lib/types/sprocket';
import ThreadTranscript from './thread-transcript';

type Props = React.ComponentProps<typeof ThreadTranscript>;

let resize: () => void;

function message(number: number): TranscriptDisplayRow {
	return {
		id: `prompt:${number}`,
		// SAFETY: Fixture IDs never leave the mounted component.
		threadId: 'thread' as Id<'threadRecords'>,
		// SAFETY: Fixture IDs never leave the mounted component.
		runId: `run-${number}` as Id<'runs'>,
		kind: 'prompt',
		text: `Message ${number}`,
		attachments: [],
		sequence: number,
		itemCount: 0,
		pendingTools: 0,
		closed: true,
		revision: 1
	};
}

function liveMessage(): LiveTranscriptMessage {
	return {
		kind: 'live',
		id: 'response:run',
		threadId: message(3).threadId,
		runId: message(3).runId,
		runStatus: 'completed',
		runStartedAt: 1,
		text: '',
		parts: []
	};
}

function click(element: Element | null | undefined) {
	act(() => {
		element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	});
}

async function settle(milliseconds = 16) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(milliseconds);
	});
}

async function renderTranscript(messages: TranscriptMessage[], viewportHeight = 600) {
	const props: Props = {
		currentError: null,
		runError: null,
		messages,
		actions: [],
		activeRunId: null,
		project: null,
		nextBefore: undefined,
		onLoadOlder: vi.fn()
	};

	const rendered = render(<ThreadTranscript {...props} />);
	const container = rendered.container;
	const viewport = container.querySelector<HTMLDivElement>('[aria-label="Conversation history"]');

	if (!viewport) throw new Error('Missing transcript viewport');

	const messageElements = () => [
		...viewport.querySelectorAll<HTMLElement>('[data-transcript-anchor]')
	];

	let scrollTop = 0;
	// jsdom has no layout. Model fixed-height rows while exercising the real DOM and effects.
	Object.defineProperties(viewport, {
		clientHeight: { get: () => viewportHeight },
		scrollHeight: {
			configurable: true,
			get: () => Math.max(viewportHeight, messageElements().length * 300)
		},
		scrollTop: {
			configurable: true,
			get: () => {
				scrollTop = Math.min(scrollTop, viewport.scrollHeight - viewport.clientHeight);

				return scrollTop;
			},
			set: (top: number) => {
				scrollTop = Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight));
			}
		}
	});
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
		this: HTMLElement
	) {
		const index = messageElements().indexOf(this);

		return new DOMRect(
			0,
			index < 0 ? 0 : index * 300 - viewport.scrollTop,
			800,
			index < 0 ? viewportHeight : 300
		);
	});
	// Layout is only observable after the mocks above, so deliver a fresh actions
	// array to make the first commit re-measure the mocked viewport.
	rendered.rerender(<ThreadTranscript {...props} actions={[...props.actions]} />);
	await settle();

	return {
		props,
		viewport,
		unmount: rendered.unmount,
		setProps(patch: Partial<Props>) {
			Object.assign(props, patch);
			rendered.rerender(<ThreadTranscript {...props} />);
		},
		scrollTo(top: number) {
			act(() => {
				viewport.scrollTop = top;
				viewport.dispatchEvent(new Event('scroll'));
			});
		}
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal(
		'ResizeObserver',
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe = vi.fn();
			disconnect = vi.fn();
		}
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('transcript viewport paging', () => {
	it('scrolls vertically without allowing the transcript viewport to scroll horizontally', async () => {
		const { viewport } = await renderTranscript([message(1)]);

		expect(viewport.classList.contains('overflow-y-auto')).toBe(true);
		expect(viewport.classList.contains('overflow-x-hidden')).toBe(true);
		expect(viewport.classList.contains('overflow-auto')).toBe(false);
	});

	it('opens every transcript link in a new tab without granting opener access', async () => {
		const prompt = { ...message(1), text: '[Prompt](https://example.com/prompt)' };

		const response: TranscriptDisplayRow = {
			...message(2),
			id: 'text-2',
			kind: 'text',
			text: '[Response](https://example.com/response)'
		};

		const live: LiveTranscriptMessage = {
			...liveMessage(),
			text: '[Live](https://example.com/live)'
		};

		const { viewport } = await renderTranscript([prompt, response, live]);

		const links = [...viewport.querySelectorAll<HTMLAnchorElement>('.chat-markdown a')];
		expect(links).toHaveLength(3);
		expect(links.every((link) => link.target === '_blank')).toBe(true);
		expect(links.every((link) => link.rel === 'noopener noreferrer')).toBe(true);
	});

	it.each(['live', 'persisted'] as const)(
		'uses the same patch and failure disclosures for %s tools',
		async (kind) => {
			const parts: LiveTranscriptMessage['parts'] = [
				{
					type: 'tool-call',
					callId: 'patch',
					name: 'apply_patch',
					input: {
						patch:
							'*** Begin Patch\n*** Add File: a.txt\n+a\n*** Add File: b.txt\n+b\n*** Add File: c.txt\n+c\n*** End Patch'
					}
				},
				{ type: 'tool-result', callId: 'patch', name: 'apply_patch', output: {} },
				{
					type: 'tool-call',
					callId: 'cancelled',
					name: 'exec_command',
					input: { cmd: 'sleep 10' }
				},
				{
					type: 'tool-result',
					callId: 'cancelled',
					name: 'exec_command',
					output: { status: 'cancelled', error: 'stopped by user' }
				},
				{ type: 'tool-call', callId: 'interrupted', name: 'read_skill', input: { name: 'test' } }
			];

			const response: TranscriptMessage =
				kind === 'live'
					? { ...liveMessage(), parts }
					: {
							...message(3),
							kind: 'work',
							id: 'work-3',
							itemCount: 3
						};

			const { props, viewport, setProps } = await renderTranscript([response]);
			setProps({
				loadSectionDetails: vi
					.fn()
					.mockResolvedValue({ parts, revision: 1, stale: false, indexing: false })
			});
			await settle();
			click(viewport.querySelector<HTMLButtonElement>('button[aria-expanded]'));
			await settle();

			const patch = [...viewport.querySelectorAll('button')].find((button) =>
				button.textContent?.includes('Changed Files')
			);

			expect(patch).toBeUndefined();
			expect(viewport.textContent).toContain('a.txt');
			expect(viewport.textContent).toContain('b.txt');
			expect(viewport.textContent).toContain('c.txt');
			const failures = [...viewport.querySelectorAll('details summary')];
			expect(failures.map((summary) => summary.textContent)).toEqual([
				expect.stringContaining('(cancelled)'),
				expect.stringContaining('(interrupted)')
			]);
			expect(failures.every((summary) => summary.querySelector('.text-amber-800'))).toBe(true);
			expect(viewport.querySelector('details [role="status"]')?.textContent).toBe(
				'stopped by user'
			);
			expect(props.loadSectionDetails).toBeDefined();
		}
	);

	it.each([false, true])(
		'reveals a synchronous call only after its result arrives with async=%s',
		async (withAsync) => {
			const response: LiveTranscriptMessage = {
				...liveMessage(),
				runStatus: 'running',
				parts: [
					{ type: 'reasoning', id: 'plan', text: 'Checking the workspace.' },
					{
						type: 'tool-call',
						callId: 'skill',
						name: 'read_skill',
						input: { name: 'hidden-skill' }
					},
					...(withAsync
						? [
								{
									type: 'tool-call' as const,
									callId: 'command',
									name: 'exec_command',
									input: { cmd: 'sleep 10' }
								}
							]
						: [])
				]
			};

			const { viewport, setProps } = await renderTranscript([response]);
			setProps({ activeRunId: response.runId });
			await settle();
			click(viewport.querySelector('button[aria-expanded]'));
			await settle();

			expect(viewport.querySelector('[title="sleep 10 (running)"]') !== null).toBe(withAsync);
			expect(viewport.querySelector('[title="sleep 10 (running)"] .animate-spin') !== null).toBe(
				withAsync
			);
			expect(viewport.querySelector('[title="sleep 10 (running)"] .sr-only')?.textContent).toBe(
				withAsync ? 'Running' : undefined
			);
			expect(viewport.textContent?.includes('sleep 10')).toBe(withAsync);
			expect(viewport.textContent).toContain('Reasoned');
			expect(viewport.textContent).not.toContain('Reasoning');
			expect(viewport.textContent).not.toContain('hidden-skill');
			expect(viewport.textContent).not.toContain('Read Skill');

			setProps({
				messages: [
					{
						...response,
						parts: [
							...response.parts,
							{ type: 'tool-result', callId: 'skill', name: 'read_skill', output: {} }
						]
					}
				]
			});
			await settle();

			expect(viewport.textContent).not.toContain('Read Skill');
			expect(viewport.textContent).toContain('hidden-skill');
			expect(viewport.querySelector('[title="sleep 10 (running)"]') !== null).toBe(withAsync);
			expect(viewport.textContent?.includes('sleep 10')).toBe(withAsync);
			expect(viewport.textContent).toContain('Reasoned');
			expect(viewport.textContent).not.toContain('Reasoning');
		}
	);

	it.each([
		{ kind: 'live', toolName: 'exec_cmd', group: 'Ran Commands' },
		{ kind: 'persisted', toolName: 'exec_cmd', group: 'Ran Commands' },
		{ kind: 'live', toolName: 'control_cmd', group: 'Controlled Commands' },
		{ kind: 'persisted', toolName: 'control_cmd', group: 'Controlled Commands' },
		{ kind: 'live', toolName: 'poll_cmd', group: 'Polled Commands' },
		{ kind: 'persisted', toolName: 'poll_cmd', group: 'Polled Commands' },
		{ kind: 'live', toolName: 'exec_command', group: 'Ran Commands' },
		{ kind: 'persisted', toolName: 'exec_command', group: 'Ran Commands' },
		{ kind: 'live', toolName: 'write_stdin', group: 'Monitored Commands' },
		{ kind: 'persisted', toolName: 'write_stdin', group: 'Monitored Commands' },
		{ kind: 'live', toolName: 'control_command', group: 'Controlled Commands' },
		{ kind: 'persisted', toolName: 'control_command', group: 'Controlled Commands' },
		{ kind: 'live', toolName: 'poll_command', group: 'Polled Commands' },
		{ kind: 'persisted', toolName: 'poll_command', group: 'Polled Commands' }
	] as const)(
		'shows $toolName as a settled snapshot in completed $kind work',
		async ({ kind, toolName, group }) => {
			const output: JsonValue =
				toolName === 'exec_cmd' || toolName === 'exec_command' || toolName === 'write_stdin'
					? { sessionId: 'session', command: 'sleep 10', running: true }
					: { command: 'sleep 10', workdir: '/', running: true };

			const parts: LiveTranscriptMessage['parts'] = [
				{
					type: 'tool-call',
					callId: 'command',
					name: toolName,
					input:
						toolName === 'exec_cmd' || toolName === 'exec_command'
							? { cmd: 'sleep 10' }
							: toolName === 'control_cmd' || toolName === 'control_command'
								? { sessionId: 'session', action: 'terminate' }
								: { sessionId: 'session' }
				},
				{
					type: 'tool-result',
					callId: 'command',
					name: toolName,
					output
				}
			];

			const response: TranscriptMessage =
				kind === 'live'
					? {
							...liveMessage(),
							runStatus: 'running',
							parts: [
								...parts,
								{ type: 'text', id: 'after-command', text: 'Doing something else.' }
							]
						}
					: {
							...message(3),
							kind: 'work',
							id: 'work-3',
							itemCount: 1,
							closed: true,
							pendingTools: 0
						};

			const { viewport, setProps } = await renderTranscript([response]);
			setProps({
				activeRunId: response.runId,
				loadSectionDetails: vi
					.fn()
					.mockResolvedValue({ parts, revision: 1, stale: false, indexing: false })
			});
			await settle();

			const work = [...viewport.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
				button.textContent?.trim().startsWith('Worked')
			);

			expect(work?.getAttribute('aria-expanded')).toBe('false');

			click(work);
			await settle();

			const commands = [...viewport.querySelectorAll('button')].find((button) =>
				button.textContent?.includes(group)
			);

			expect(commands).toBeUndefined();
			expect(viewport.querySelector('.animate-spin')).toBeNull();
			expect(viewport.querySelector('[title="sleep 10"]')).not.toBeNull();
			expect(viewport.textContent).toContain('Still running when this call returned');
		}
	);

	it('labels a poll_command row with the command from the originating exec_command session', async () => {
		const parts: LiveTranscriptMessage['parts'] = [
			{
				type: 'tool-call',
				callId: 'launch',
				name: 'exec_command',
				input: { cmd: 'npm run dev', yieldTimeMs: 0 }
			},
			{
				type: 'tool-result',
				callId: 'launch',
				name: 'exec_command',
				output: { sessionId: '7', running: true, success: false, output: '' }
			},
			{
				type: 'tool-call',
				callId: 'poll',
				name: 'poll_command',
				input: { sessionId: '7' }
			},
			{
				type: 'tool-result',
				callId: 'poll',
				name: 'poll_command',
				output: { workdir: '/app', running: true, success: false }
			}
		];

		const response: TranscriptMessage = {
			...liveMessage(),
			runStatus: 'running',
			parts: [...parts, { type: 'text', id: 'after', text: 'Doing something else.' }]
		};

		const { viewport, setProps } = await renderTranscript([response]);
		setProps({
			activeRunId: response.runId,
			loadSectionDetails: vi
				.fn()
				.mockResolvedValue({ parts, revision: 1, stale: false, indexing: false })
		});
		await settle();

		const transcript = within(viewport);

		click(transcript.getByRole('button', { name: /^Worked/ }));
		await settle();

		expect(transcript.getAllByTitle('npm run dev')).toHaveLength(2);
		expect(transcript.getAllByText('Still running when this call returned')).toHaveLength(2);
	});

	it('continues persisted work in the same disclosure while the next model turn streams', async () => {
		const work: TranscriptDisplayRow = {
			...message(3),
			kind: 'work',
			id: 'work-3',
			closed: false,
			startedAt: 1_000,
			itemCount: 1
		};

		const live: LiveTranscriptMessage = {
			...liveMessage(),
			runStatus: 'running',
			parts: [
				{
					type: 'reasoning',
					id: 'live-reasoning',
					text: 'Current reasoning',
					startedAt: 2_000,
					completedAt: 2_500
				}
			]
		};

		const { props, viewport, setProps } = await renderTranscript([work, live]);
		setProps({
			activeRunId: live.runId,
			loadSectionDetails: vi.fn().mockResolvedValue({
				parts: [
					{
						type: 'reasoning',
						id: 'saved-reasoning',
						text: 'Saved reasoning',
						startedAt: 1_000,
						completedAt: 1_500
					}
				],
				revision: 1,
				stale: false,
				indexing: false
			})
		});
		await settle();

		const workButtons = [...viewport.querySelectorAll<HTMLButtonElement>('button')].filter(
			(button) => button.textContent?.trim().startsWith('Working')
		);

		expect(workButtons).toHaveLength(1);
		expect(workButtons[0].getAttribute('aria-expanded')).toBe('false');
		expect(props.loadSectionDetails).not.toHaveBeenCalled();
		expect(viewport.textContent).not.toContain('Current reasoning');
		click(workButtons[0]);
		await settle();
		expect(props.loadSectionDetails).toHaveBeenCalledWith(work, {}, expect.any(AbortSignal));

		const reasoningLabels = [...viewport.querySelectorAll<HTMLButtonElement>('button')].flatMap(
			(button) => {
				const label = button.textContent?.trim();

				return label === 'Reasoned' || label === 'Reasoning' ? [label] : [];
			}
		);

		expect(reasoningLabels).toEqual(['Reasoned', 'Reasoning']);
		expect(viewport.textContent).toContain('Current reasoning');
	});

	it('starts a new disclosure when streamed model text separates work', async () => {
		const work: TranscriptDisplayRow = {
			...message(3),
			kind: 'work',
			id: 'work-3',
			closed: false,
			startedAt: 1_000,
			itemCount: 1
		};

		const live: LiveTranscriptMessage = {
			...liveMessage(),
			runStatus: 'running',
			parts: [
				{
					type: 'text',
					id: 'boundary',
					text: 'Visible boundary',
					startedAt: 3_000,
					completedAt: 3_500
				},
				{
					type: 'reasoning',
					id: 'after-boundary',
					text: 'More work',
					startedAt: 4_000,
					completedAt: 4_500
				}
			]
		};

		const { viewport, setProps } = await renderTranscript([work, live]);
		setProps({ activeRunId: live.runId });
		await settle();

		const workLabels = [...viewport.querySelectorAll<HTMLButtonElement>('button')].flatMap(
			(button) => {
				const label = button.textContent?.trim() ?? '';

				return label.startsWith('Work') ? [label] : [];
			}
		);

		expect(workLabels[0]).toBe('Worked for 2s');
		expect(workLabels[1]).toMatch(/^Working/);
		expect(workLabels).toHaveLength(2);

		const workButtons = [...viewport.querySelectorAll<HTMLButtonElement>('button')].filter(
			(button) => button.textContent?.trim().startsWith('Work')
		);

		expect(workButtons.map((button) => button.getAttribute('aria-expanded'))).toEqual([
			'false',
			'false'
		]);
		expect(viewport.textContent).toContain('Visible boundary');
	});

	it('keeps long work sections as summaries and fetches a bounded page only after expansion', async () => {
		const summary = (number: number): TranscriptDisplayRow => ({
			...message(number),
			id: `work-${number}`,
			kind: 'work',
			text: '',
			itemCount: 4_000,
			startedAt: 1_000,
			completedAt: 3_001_000
		});

		const first = summary(1);
		const { viewport, setProps } = await renderTranscript([message(0), first, summary(2)]);
		let edgeVisible = false;
		const geometry = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation();

		if (!geometry) throw new Error('Missing viewport geometry');
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLElement
		) {
			return this.hasAttribute('data-work-edge')
				? new DOMRect(0, edgeVisible ? 500 : 3_000, 800, 1)
				: geometry.call(this);
		});

		const load = vi
			.fn()
			.mockResolvedValueOnce({
				parts: [{ type: 'reasoning', id: 'detail', text: 'Requested detail' }],
				nextAfter: 5,
				revision: 1,
				stale: false,
				indexing: false
			})
			.mockImplementation(() => new Promise(() => {}));

		setProps({ loadSectionDetails: load });
		await settle();
		expect(load).not.toHaveBeenCalled();
		expect(viewport.querySelectorAll('[data-transcript-anchor]')).toHaveLength(3);

		const buttons = [...viewport.querySelectorAll<HTMLButtonElement>('button')].filter((button) =>
			button.textContent?.includes('Worked for')
		);

		expect(buttons.map((button) => button.textContent?.trim())).toEqual([
			'Worked for 50m 0s',
			'Worked for 50m 0s'
		]);
		click(buttons[0]);
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		expect(load.mock.calls[0][0].id).toBe(first.id);
		expect(load.mock.calls[0][1]).toEqual({});
		expect(viewport.textContent).not.toMatch(/Next details|Previous details/);
		edgeVisible = true;
		act(() => resize());
		await settle();
		expect(load.mock.calls[1][1]).toEqual({ after: 5 });
		const signal: AbortSignal = load.mock.calls[1][2];
		click(buttons[0]);
		await settle();
		expect(signal.aborted).toBe(true);
		expect(viewport.textContent).not.toContain('Next details');
	});

	it.each([false, true])(
		'anchors the visible tool after prepending, including movement during the request: %s',
		async (moveWhileLoading) => {
			const work: TranscriptDisplayRow = {
				...message(2),
				id: 'work',
				kind: 'work',
				itemCount: 10,
				closed: false
			};

			const { viewport, scrollTo, setProps } = await renderTranscript([
				message(0),
				message(1),
				work,
				message(3)
			]);

			setProps({ nextBefore: undefined });

			const rows = () =>
				[...viewport.querySelectorAll<HTMLElement>('[data-work-detail]')].filter(
					(element) => !element.querySelector('[data-work-detail]')
				);

			Object.defineProperty(viewport, 'scrollHeight', { get: () => 1200 + rows().length * 100 });
			let olderVisible = false;
			vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
				this: HTMLElement
			) {
				if (this === viewport) return new DOMRect(0, 0, 800, 600);

				if (this.hasAttribute('data-work-edge'))
					return new DOMRect(
						0,
						olderVisible && this.dataset.workEdge === 'older' ? 100 : 3_000,
						800,
						1
					);
				const details = rows();
				const detailIndex = details.indexOf(this);

				if (detailIndex >= 0)
					return new DOMRect(0, 650 + detailIndex * 100 - viewport.scrollTop, 800, 100);
				const index = [...viewport.querySelectorAll('[data-transcript-anchor]')].indexOf(this);

				return new DOMRect(
					0,
					index * 300 + (index === 3 ? details.length * 100 : 0) - viewport.scrollTop,
					800,
					300
				);
			});

			function page(ids: number[], previousBefore?: number): TranscriptDisplayDetails {
				return {
					parts: ids.flatMap((id) => [
						{
							type: 'tool-call' as const,
							callId: String(id),
							name: 'exec_command',
							input: { cmd: `echo ${id}` }
						},
						{ type: 'tool-result' as const, callId: String(id), name: 'exec_command', output: {} }
					]),
					previousBefore,
					revision: 1,
					indexing: false,
					stale: false
				};
			}

			let resolve!: (value: TranscriptDisplayDetails) => void;

			const load = vi
				.fn()
				.mockResolvedValueOnce(page([6, 7], 6))
				.mockImplementation(
					() =>
						new Promise<TranscriptDisplayDetails>((done) => {
							resolve = done;
						})
				);

			setProps({ loadSectionDetails: load, activeRunId: work.runId });
			await settle();

			const disclosure = [...viewport.querySelectorAll<HTMLButtonElement>('button')].find(
				(button) => button.textContent?.trim().startsWith('Working')
			);

			expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
			click(disclosure);
			await settle();
			expect(load).toHaveBeenCalledTimes(1);
			scrollTo(700);
			const anchor = rows()[0];
			olderVisible = true;
			scrollTo(699);
			await settle();
			expect(load.mock.calls[1][1]).toEqual({ before: 6 });

			if (moveWhileLoading) scrollTo(660);
			const offset = anchor.getBoundingClientRect().top;
			await act(async () => {
				resolve(page([4, 5]));
			});
			await settle();
			expect(anchor.isConnected).toBe(true);
			expect(anchor.getBoundingClientRect().top).toBe(offset);
			expect(viewport.scrollTop).toBe(moveWhileLoading ? 860 : 899);
			act(() => resize());
			expect(viewport.scrollTop).toBe(moveWhileLoading ? 860 : 899);
		}
	);

	it('does not claim an empty thread has a local copy when reconnecting', async () => {
		const { viewport, setProps } = await renderTranscript([]);
		setProps({ stale: true });
		await settle();
		expect(viewport.querySelector('[role="status"]')?.textContent).toContain(
			'Reconnecting to conversation history.'
		);
		expect(viewport.textContent).not.toContain('local copy');
	});

	it('keeps prefetching nearby history without rendering pagination controls', async () => {
		const { props, viewport, setProps } = await renderTranscript([message(3)]);
		setProps({ nextBefore: 3 });
		await settle();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		setProps({ nextBefore: 2 });
		await settle();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(2);
		setProps({ nextBefore: 1 });
		await settle();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(3);
		expect(viewport.textContent).not.toMatch(/Load(?:ing)? older messages/);
	});

	it('fills ahead after the first page arrives until history is outside the lookahead range', async () => {
		const { props, viewport, setProps } = await renderTranscript([]);
		expect(props.onLoadOlder).not.toHaveBeenCalled();
		setProps({ messages: [message(3)], nextBefore: 3 });
		await settle();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		setProps({ messages: [1, 2, 3].map(message), nextBefore: 1 });
		await settle();
		act(() => resize());
		expect(props.onLoadOlder).toHaveBeenCalledTimes(2);
		expect(viewport.scrollTop).toBe(300);
	});

	it('does not drop an upward scroll just after a resize notification', async () => {
		const { props, viewport, scrollTo, setProps } = await renderTranscript(
			[1, 2, 3, 4, 5].map(message)
		);

		act(() => resize());
		scrollTo(500);
		expect(props.onLoadOlder).not.toHaveBeenCalled();
		setProps({ messages: [...props.messages, message(6)] });
		await settle();
		act(() => resize());
		expect(viewport.scrollTop).toBe(500);
	});

	it('follows new output only at the bottom, and resumes after scrolling back down', async () => {
		const { props, viewport, scrollTo, setProps } = await renderTranscript(
			[1, 2, 3, 4].map(message)
		);

		setProps({ messages: [...props.messages, message(5)] });
		await settle();
		expect(viewport.scrollTop).toBe(900);
		scrollTo(500);
		setProps({ messages: [...props.messages, message(6)] });
		await settle();
		expect(viewport.scrollTop).toBe(500);
		scrollTo(1200);
		setProps({ messages: [...props.messages, message(7)] });
		await settle();
		expect(viewport.scrollTop).toBe(1500);
	});

	it.each(['wheel', 'touch', 'ArrowUp', 'PageUp', 'Home', 'Shift+Space'])(
		'stops following on upward %s input before a scroll event, even without older pages',
		async (input) => {
			const { props, viewport, scrollTo, setProps } = await renderTranscript(
				[1, 2, 3, 4, 5].map(message)
			);

			setProps({ nextBefore: undefined });
			await settle();
			act(() => {
				if (input === 'wheel') {
					viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, bubbles: true }));
				} else if (input === 'touch') {
					for (const [type, clientY] of [
						['touchstart', 100],
						['touchmove', 110]
					] as const) {
						const event = new Event(type, { bubbles: true });
						Object.defineProperty(event, 'touches', { value: [{ clientY }] });
						viewport.dispatchEvent(event);
					}
				} else {
					viewport.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: input === 'Shift+Space' ? ' ' : input,
							shiftKey: input === 'Shift+Space',
							bubbles: true
						})
					);
				}
			});
			setProps({ messages: [...props.messages, message(6)] });
			await settle();
			act(() => resize());
			expect(viewport.scrollTop).toBe(900);
			expect(props.onLoadOlder).not.toHaveBeenCalled();
			scrollTo(1200);
			setProps({ messages: [...props.messages, message(7)] });
			await settle();
			expect(viewport.scrollTop).toBe(1500);
		}
	);

	it('does not pull a small upward scroll back into the bottom tolerance', async () => {
		const { props, viewport, scrollTo, setProps } = await renderTranscript(
			[1, 2, 3, 4, 5].map(message)
		);

		scrollTo(890);
		setProps({ messages: [...props.messages, message(6)] });
		await settle();
		act(() => resize());
		expect(viewport.scrollTop).toBe(890);
	});

	it('respects a scrollbar move before its scroll event reaches the component', async () => {
		const { props, viewport, setProps } = await renderTranscript([1, 2, 3, 4, 5].map(message));
		viewport.scrollTop = 700;
		act(() => resize());
		expect(viewport.scrollTop).toBe(700);
		setProps({ messages: [...props.messages, message(6)] });
		await settle();
		expect(viewport.scrollTop).toBe(700);
	});

	it('does not write the scroll position for a resize that leaves the bottom unchanged', async () => {
		const { viewport } = await renderTranscript([1, 2, 3, 4].map(message));
		const writeScrollTop = vi.spyOn(viewport, 'scrollTop', 'set');
		act(() => resize());
		act(() => resize());
		expect(writeScrollTop).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		'preserves bottom-following state %s when shrinking content clamps the scroll position',
		async (following) => {
			const { props, viewport, scrollTo, setProps } = await renderTranscript(
				[1, 2, 3, 4, 5].map(message)
			);

			if (!following) scrollTo(700);
			setProps({ messages: props.messages.slice(0, 3) });
			act(() => {
				viewport.dispatchEvent(new Event('scroll'));
			});
			await settle();
			act(() => resize());
			expect(viewport.scrollTop).toBe(300);
			setProps({ messages: [...props.messages, message(4)] });
			await settle();
			expect(viewport.scrollTop).toBe(following ? 600 : 300);
		}
	);

	it('opens a newly mounted thread at the bottom rather than reusing the previous reading position', async () => {
		const first = await renderTranscript([1, 2, 3, 4].map(message));
		first.scrollTo(100);
		first.unmount();
		const second = await renderTranscript([]);
		second.setProps({ messages: [11, 12, 13, 14, 15].map(message) });
		await settle();
		expect(second.viewport.scrollTop).toBe(900);
		expect(second.viewport.textContent).not.toContain('Message 4');
	});

	it('starts loading three viewports ahead of the top', async () => {
		const { props, viewport, scrollTo, setProps } = await renderTranscript(
			[1, 2, 3, 4, 5, 6, 7, 8, 9].map(message)
		);

		setProps({ nextBefore: 3 });
		await settle();
		expect(props.onLoadOlder).not.toHaveBeenCalled();
		expect(viewport.scrollTop).toBe(2_100);
		scrollTo(1_801);
		expect(props.onLoadOlder).not.toHaveBeenCalled();
		scrollTo(1_800);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		scrollTo(1_900);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		setProps({ loadingOlder: true });
		await settle();
		scrollTo(0);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
	});

	it('bounds short-history lookahead until the reader moves', async () => {
		const { props, viewport, setProps } = await renderTranscript([message(3)]);
		expect(viewport.textContent).not.toContain('Load earlier messages');
		setProps({ nextBefore: 3 });
		await settle();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		setProps({ loadingOlder: true });
		await settle();
		expect(viewport.textContent).not.toContain('Loading earlier messages');
		setProps({ nextBefore: 2, loadingOlder: false });
		await settle();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(2);
		setProps({ nextBefore: 1 });
		await settle();
		setProps({ nextBefore: 0 });
		await settle();
		await settle(10_000);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(3);
		act(() => {
			viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
		});
		expect(props.onLoadOlder).toHaveBeenCalledTimes(4);
	});

	it('does not duplicate a pending cursor during repeated input', async () => {
		const { props, viewport, setProps } = await renderTranscript([message(3)]);

		const touch = (type: string, clientY: number) => {
			act(() => {
				const event = new Event(type, { bubbles: true });
				Object.defineProperty(event, 'touches', { value: [{ clientY }] });
				viewport.dispatchEvent(event);
			});
		};

		setProps({ nextBefore: 3 });
		await settle();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		setProps({ loadingOlder: true });
		await settle();
		setProps({ stale: true, loadingOlder: false });
		await settle();
		await settle(10_000);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		touch('touchstart', 100);
		touch('touchmove', 150);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
	});

	it('preserves a text section when older parts are prepended inside the same response', async () => {
		const response: LiveTranscriptMessage = {
			...liveMessage(),
			parts: [3, 4, 5, 6].map((number) => ({
				type: 'text',
				id: `text-${number}`,
				text: `Part ${number}`
			}))
		};

		const { viewport, scrollTo, setProps } = await renderTranscript([response]);
		scrollTo(150);

		const anchor = viewport.querySelector<HTMLElement>(
			'[data-transcript-anchor="response:run:text::text-3"]'
		);

		if (!anchor) throw new Error('Missing visible response section');
		const offset = anchor.getBoundingClientRect().top;
		setProps({
			messages: [
				{
					...response,
					parts: [{ type: 'text', id: 'text-2', text: 'Older part' }, ...response.parts]
				}
			]
		});
		await settle();
		expect(anchor.isConnected).toBe(true);
		expect(anchor.getBoundingClientRect().top).toBe(offset);
		expect(viewport.scrollTop).toBe(450);
	});

	it('preserves the visible message offset when an older page is prepended', async () => {
		const { props, viewport, scrollTo, setProps } = await renderTranscript(
			[3, 4, 5, 6].map(message)
		);

		scrollTo(150);
		const anchor = viewport.querySelector<HTMLElement>('[data-message-id="prompt:3"]');

		if (!anchor) throw new Error('Missing visible message');
		const offset = anchor.getBoundingClientRect().top;
		setProps({ messages: [message(1), message(2), ...props.messages] });
		await settle();
		act(() => {
			viewport.dispatchEvent(new Event('scroll'));
		});
		expect(viewport.scrollTop).toBe(750);
		expect(anchor.getBoundingClientRect().top).toBe(offset);
		expect(props.onLoadOlder).not.toHaveBeenCalled();
	});

	it('keeps a work disclosure open when a page prepends parts into that section', async () => {
		const response: LiveTranscriptMessage = {
			...liveMessage(),
			parts: [
				{ type: 'reasoning', id: 'r3', text: 'Recent reasoning' },
				{ type: 'text', id: 't4', text: 'Answer' }
			]
		};

		const { setProps, viewport } = await renderTranscript([response]);
		const button = viewport.querySelector<HTMLButtonElement>('button[aria-expanded]');

		if (!button) throw new Error('Missing work disclosure');
		click(button);
		await settle();
		expect(button.getAttribute('aria-expanded')).toBe('true');
		setProps({
			messages: [
				{
					...response,
					parts: [{ type: 'reasoning', id: 'r2', text: 'Older reasoning' }, ...response.parts]
				}
			]
		});
		await settle();
		expect(button.isConnected).toBe(true);
		expect(button.getAttribute('aria-expanded')).toBe('true');
	});

	it.each([false, true])(
		'keeps disclosure state on its own work when sections split: %s',
		async (split) => {
			const first = { type: 'reasoning' as const, id: 'r1', text: 'First work' };
			const second = { type: 'reasoning' as const, id: 'r2', text: 'Second work' };

			const response: LiveTranscriptMessage = {
				...liveMessage(),
				parts: split ? [first, second] : [first]
			};

			const { setProps, viewport } = await renderTranscript([response]);

			const original = viewport.querySelector<HTMLButtonElement>(
				'[data-transcript-anchor] > div > button'
			);

			if (!original) throw new Error('Missing original work disclosure');
			click(original);
			await settle();
			setProps({
				messages: [
					{ ...response, parts: [first, { type: 'text', id: 't1', text: 'Update' }, second] }
				]
			});
			await settle();

			const buttons = viewport.querySelectorAll<HTMLButtonElement>(
				'[data-transcript-anchor] > div > button'
			);

			expect(buttons).toHaveLength(2);
			expect(buttons[0]).toBe(original);
			expect(buttons[0]?.getAttribute('aria-expanded')).toBe('true');
			expect(buttons[1]?.getAttribute('aria-expanded')).toBe('false');
		}
	);
});
