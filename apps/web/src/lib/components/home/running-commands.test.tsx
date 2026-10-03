import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RunningCommands, { RunningCommandsView } from './running-commands';
import { useRunningCommands, type CommandApi } from '$lib/home/running-commands';
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
	it('renders nothing for an empty thread', () => {
		const view = render(
			<RunningCommandsView commands={[]} stopping={[]} error={null} onTerminate={vi.fn()} />
		);

		expect(view.container.childElementCount).toBe(0);
	});

	it('collapses to the heading and restores command controls when expanded', () => {
		const onTerminate = vi.fn();
		render(
			<RunningCommandsView
				commands={[command]}
				stopping={[]}
				error="Server offline"
				onTerminate={onTerminate}
			/>
		);
		const toggle = screen.getByRole('button', { name: 'Running commands' });
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByText('bun run dev')).toBeNull();
		expect(screen.queryByText('/workspace/sprocket')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Stop command: bun run dev' })).toBeNull();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.getByRole('region', { name: 'Running commands' }).textContent).toBe(
			'Running commands1'
		);
		expect(onTerminate).not.toHaveBeenCalled();
		fireEvent.click(toggle);
		expect(screen.getByRole('button', { name: 'Stop command: bun run dev' })).toBeTruthy();
		expect(screen.getByText('/workspace/sprocket')).toBeTruthy();
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
		const stop = screen.getByRole('button', { name: 'Stop command: bun run dev' });
		fireEvent.click(stop);
		expect(api.terminateCommand).toHaveBeenCalledWith({ ...scope('thread'), sessionId: '1' });
		expect(stop.hasAttribute('disabled')).toBe(true);
		await act(async () => {
			finish({ terminated: true });
		});
		expect(screen.getByText('bun run dev')).toBeTruthy();
	});

	it('does not overlap requests and ignores responses from a previous thread', async () => {
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
		view.rerender(<RunningCommands api={api} scope={scope('new')} />);
		expect(list.mock.calls[0][1]?.aborted).toBe(true);
		await act(async () => {
			finish({ commands: [command] });
		});
		expect(screen.queryByText('bun run dev')).toBeNull();
		view.unmount();
		await flush(5_000);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it('reports termination failures and enables retry', async () => {
		const api: CommandApi = {
			listRunningCommands: vi.fn(async () => ({ commands: [command] })),
			terminateCommand: vi.fn().mockRejectedValue(new Error('Server offline'))
		};

		render(<RunningCommands api={api} scope={scope('thread')} />);
		await flush();
		fireEvent.click(screen.getByRole('button', { name: 'Stop command: bun run dev' }));
		await flush();
		expect(screen.getByRole('alert').textContent).toBe('Server offline');
		expect(
			screen.getByRole('button', { name: 'Stop command: bun run dev' }).hasAttribute('disabled')
		).toBe(false);
		await flush(1_000);
		expect(screen.getByRole('alert').textContent).toBe('Server offline');
	});

	it('deduplicates concurrent stop requests before React renders the disabled button', async () => {
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

		const { result } = renderHook(() => useRunningCommands(api, scope('thread')));
		await flush();
		act(() => {
			void result.current.terminate('1');
			void result.current.terminate('1');
		});
		expect(api.terminateCommand).toHaveBeenCalledTimes(1);
		await act(async () => {
			finish({ terminated: true });
		});
	});

	it('does not carry pending stops or their failures into another thread', async () => {
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
		fireEvent.click(screen.getByRole('button', { name: 'Stop command: bun run dev' }));
		expect(
			screen.getByRole('button', { name: 'Stop command: bun run dev' }).hasAttribute('disabled')
		).toBe(true);
		view.rerender(<RunningCommands api={api} scope={scope('new')} />);
		await flush();
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
	});

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
		expect(screen.getByText('bun run dev')).toBeTruthy();
		expect(screen.getByRole('alert').textContent).toContain('Reconnecting');
		await flush(1_000);
		expect(screen.getByText('bun run dev')).toBeTruthy();
		expect(screen.queryByRole('alert')).toBeNull();
	});
});
