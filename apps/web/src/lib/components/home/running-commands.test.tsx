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

async function flush(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => vi.useRealTimers());

describe('running commands dashboard', () => {
	it('starts collapsed and toggles command controls', async () => {
		const api: CommandApi = {
			listRunningCommands: vi.fn(async () => ({ commands: [command] })),
			terminateCommand: vi.fn()
		};

		render(<RunningCommands api={api} scope={scope('thread')} />);
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

	it('tracks commands after a run and disappears when the last process exits', async () => {
		const api: CommandApi = {
			listRunningCommands: vi
				.fn()
				.mockResolvedValueOnce({ commands: [command] })
				.mockResolvedValue({ commands: [] }),
			terminateCommand: vi.fn()
		};

		render(<RunningCommands api={api} scope={scope('thread')} />);
		await flush();
		expect(screen.getByRole('region', { name: 'Running commands' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Running commands' }));
		expect(screen.getByText('/workspace/sprocket')).toBeTruthy();
		await flush(1_000);
		expect(screen.queryByRole('region', { name: 'Running commands' })).toBeNull();
	});

	it('stops only the selected command and keeps it visible until the server confirms exit', async () => {
		let finish!: (value: { terminated: boolean }) => void;

		const api: CommandApi = {
			listRunningCommands: vi.fn(async () => ({ commands: [command] })),
			terminateCommand: vi.fn(
				() =>
					new Promise<{ terminated: boolean }>((resolve) => {
						finish = resolve;
					})
			)
		};

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
		'does not overlap requests and ignores previous responses after a %s change',
		async (change) => {
			let finish!: (value: { commands: RunningCommand[] }) => void;

			const list = vi
				.fn<CommandApi['listRunningCommands']>()
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finish = resolve;
						})
				)
				.mockResolvedValue({ commands: [] });

			const api: CommandApi = { listRunningCommands: list, terminateCommand: vi.fn() };
			const view = render(<RunningCommands api={api} scope={scope('old')} />);
			await flush(5_000);
			expect(list).toHaveBeenCalledTimes(1);
			view.rerender(
				<RunningCommands
					api={change === 'api' ? { ...api } : api}
					scope={scope(change === 'thread' ? 'new' : 'old')}
				/>
			);
			expect(list.mock.calls[0][1]?.aborted).toBe(true);
			await act(async () => {
				finish({ commands: [command] });
			});
			expect(screen.queryByText('bun run dev')).toBeNull();
			view.unmount();
			await flush(5_000);
			expect(list).toHaveBeenCalledTimes(2);
		}
	);

	it('reports termination failures and enables retry', async () => {
		const api: CommandApi = {
			listRunningCommands: vi.fn(async () => ({ commands: [command] })),
			terminateCommand: vi.fn().mockRejectedValue(new Error('Server offline'))
		};

		render(<RunningCommands api={api} scope={scope('thread')} />);
		await flush();
		fireEvent.click(screen.getByRole('button', { name: 'Running commands' }));
		fireEvent.click(screen.getByRole('button', { name: 'Stop command: bun run dev' }));
		await flush();
		expect(screen.getByRole('alert').textContent).toBe('Server offline');
		expect(
			screen.getByRole('button', { name: 'Stop command: bun run dev' }).hasAttribute('disabled')
		).toBe(false);
		await flush(1_000);
		expect(screen.getByRole('alert').textContent).toBe('Server offline');
	});

	it.each(['thread', 'api'] as const)(
		'does not carry pending stops or their failures across a %s change',
		async (change) => {
			let fail!: (error: Error) => void;

			const api: CommandApi = {
				listRunningCommands: vi.fn(async () => ({ commands: [command] })),
				terminateCommand: vi.fn(
					() =>
						new Promise<{ terminated: boolean }>((_, reject) => {
							fail = reject;
						})
				)
			};

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

	it('recovers from a polling failure without hiding known running commands', async () => {
		const api: CommandApi = {
			listRunningCommands: vi
				.fn()
				.mockResolvedValueOnce({ commands: [command] })
				.mockRejectedValueOnce(new Error('Server offline'))
				.mockResolvedValue({ commands: [command] }),
			terminateCommand: vi.fn()
		};

		render(<RunningCommands api={api} scope={scope('thread')} />);
		await flush(1_000);
		fireEvent.click(screen.getByRole('button', { name: 'Running commands' }));
		expect(screen.getByText('bun run dev')).toBeTruthy();
		expect(screen.getByRole('alert').textContent).toContain('Reconnecting');
		await flush(1_000);
		expect(screen.getByText('bun run dev')).toBeTruthy();
		expect(screen.queryByRole('alert')).toBeNull();
	});
});
