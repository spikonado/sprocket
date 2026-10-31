import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RunningCommands from './running-commands';
import type { CommandApi } from '$lib/home/running-commands';
import type { RunningCommand, TranscriptScopeRequest } from '$lib/types/sprocket';

const command: RunningCommand = {
	sessionId: '1',
	command: 'bun run dev',
	workdir: '/workspace/sprocket',
	startedAt: 1
};

function scope(thread: string): TranscriptScopeRequest {
	// SAFETY: test IDs are opaque strings and never sent to Convex.
	return { userId: 'user', threadId: thread as TranscriptScopeRequest['threadId'] };
}

type Watch = {
	signal: AbortSignal;
	emit: (commands: RunningCommand[]) => void;
	fail: (error: Error) => void;
};

/** Each watch emits `initial` once it starts; tests drive later updates through `watches`. */
function commandApi(
	initial: RunningCommand[] | null,
	terminateCommand: CommandApi['terminateCommand'] = vi.fn()
) {
	const watches: Watch[] = [];

	const watchRunningCommands = vi.fn<CommandApi['watchRunningCommands']>(
		(_request, { signal, onEvent }) =>
			new Promise<void>((resolve, reject) => {
				signal.addEventListener('abort', () => resolve(), { once: true });
				watches.push({ signal, emit: onEvent, fail: reject });

				if (initial) onEvent(initial);
			})
	);

	const api: CommandApi = { watchRunningCommands, terminateCommand };

	return { api, watches, watchRunningCommands };
}

async function flush(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => vi.useRealTimers());

describe('running commands dashboard', () => {
	it('starts collapsed and toggles command controls', async () => {
		render(<RunningCommands api={commandApi([command]).api} scope={scope('thread')} />);
		await flush();
		const toggle = screen.getByRole('button', { name: 'Running commands' });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByRole('button', { name: 'Stop command: bun run dev' })).toBeNull();
		expect(screen.getByText('1')).toBeTruthy();
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByRole('button', { name: 'Stop command: bun run dev' })).toBeTruthy();
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
	});

	it('tracks pushed commands and disappears when the last process exits', async () => {
		const { api, watches } = commandApi([command]);

		render(<RunningCommands api={api} scope={scope('thread')} />);
		await flush();
		expect(screen.getByRole('region', { name: 'Running commands' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Running commands' }));
		expect(screen.getByText('/workspace/sprocket')).toBeTruthy();
		act(() => watches[0].emit([]));
		expect(screen.queryByRole('region', { name: 'Running commands' })).toBeNull();
	});

	it('stops only the selected command and keeps it visible until the server confirms exit', async () => {
		let finish!: (value: { terminated: boolean }) => void;

		const { api } = commandApi(
			[command],
			vi.fn(
				() =>
					new Promise<{ terminated: boolean }>((resolve) => {
						finish = resolve;
					})
			)
		);

		render(<RunningCommands api={api} scope={scope('thread')} />);
		await flush();
		fireEvent.click(screen.getByRole('button', { name: 'Running commands' }));
		const stop = screen.getByRole('button', { name: 'Stop command: bun run dev' });
		fireEvent.click(stop);
		expect(api.terminateCommand).toHaveBeenCalledWith({ ...scope('thread'), sessionId: '1' });
		expect(stop.hasAttribute('disabled')).toBe(true);
		fireEvent.click(stop);
		expect(api.terminateCommand).toHaveBeenCalledTimes(1);
		await act(async () => {
			finish({ terminated: true });
		});
		expect(screen.getByText('bun run dev')).toBeTruthy();
	});

	it.each(['thread', 'api'] as const)(
		'ignores the previous watch after a %s change',
		async (change) => {
			const { api, watches, watchRunningCommands } = commandApi(null);
			const view = render(<RunningCommands api={api} scope={scope('old')} />);
			await flush();
			view.rerender(
				<RunningCommands
					api={change === 'api' ? { ...api } : api}
					scope={scope(change === 'thread' ? 'new' : 'old')}
				/>
			);
			expect(watches[0].signal.aborted).toBe(true);
			act(() => watches[0].emit([command]));
			expect(screen.queryByText('bun run dev')).toBeNull();
			expect(watchRunningCommands).toHaveBeenCalledTimes(2);
			view.unmount();
			expect(watches[1].signal.aborted).toBe(true);
		}
	);

	it('reports termination failures and enables retry', async () => {
		const { api } = commandApi([command], vi.fn().mockRejectedValue(new Error('Server offline')));

		render(<RunningCommands api={api} scope={scope('thread')} />);
		await flush();
		fireEvent.click(screen.getByRole('button', { name: 'Running commands' }));
		fireEvent.click(screen.getByRole('button', { name: 'Stop command: bun run dev' }));
		fireEvent.click(screen.getByRole('button', { name: 'Running commands' }));
		await flush();
		expect(screen.getByRole('alert').textContent).toBe('Server offline');
		fireEvent.click(screen.getByRole('button', { name: 'Running commands' }));
		expect(
			screen.getByRole('button', { name: 'Stop command: bun run dev' }).hasAttribute('disabled')
		).toBe(false);
	});

	it.each(['thread', 'api'] as const)(
		'does not carry pending stops or their failures across a %s change',
		async (change) => {
			let fail!: (error: Error) => void;

			const { api } = commandApi(
				[command],
				vi.fn(
					() =>
						new Promise<{ terminated: boolean }>((_, reject) => {
							fail = reject;
						})
				)
			);

			const view = render(<RunningCommands api={api} scope={scope('old')} />);
			await flush();
			fireEvent.click(screen.getByRole('button', { name: 'Running commands' }));
			fireEvent.click(screen.getByRole('button', { name: 'Stop command: bun run dev' }));
			expect(
				screen.getByRole('button', { name: 'Stop command: bun run dev' }).hasAttribute('disabled')
			).toBe(true);
			view.rerender(
				<RunningCommands
					api={change === 'api' ? { ...api } : api}
					scope={scope(change === 'thread' ? 'new' : 'old')}
				/>
			);
			await flush();

			if (change === 'thread') {
				expect(
					screen.getByRole('button', { name: 'Running commands' }).getAttribute('aria-expanded')
				).toBe('false');
				fireEvent.click(screen.getByRole('button', { name: 'Running commands' }));
			}

			expect(
				screen.getByRole('button', { name: 'Stop command: bun run dev' }).hasAttribute('disabled')
			).toBe(false);
			await act(async () => {
				fail(new Error('Previous thread stop failed'));
			});
			expect(screen.queryByRole('alert')).toBeNull();
			expect(
				screen.getByRole('button', { name: 'Stop command: bun run dev' }).hasAttribute('disabled')
			).toBe(false);
		}
	);

	it('shows a lost watch while collapsed and recovers without losing known commands', async () => {
		const { api, watches } = commandApi([command]);

		render(<RunningCommands api={api} scope={scope('thread')} />);
		await flush();
		await act(async () => watches[0].fail(new Error('Server offline')));
		expect(screen.getByRole('region', { name: 'Running commands' })).toBeTruthy();
		expect(
			screen.getByRole('button', { name: 'Running commands' }).getAttribute('aria-expanded')
		).toBe('false');
		expect(screen.getByRole('alert').textContent).toContain('Reconnecting');
		fireEvent.click(screen.getByRole('button', { name: 'Running commands' }));
		expect(screen.getByText('bun run dev')).toBeTruthy();
		await flush(1_000);
		expect(watches).toHaveLength(2);
		expect(screen.getByText('bun run dev')).toBeTruthy();
		expect(screen.queryByRole('alert')).toBeNull();
	});
});
