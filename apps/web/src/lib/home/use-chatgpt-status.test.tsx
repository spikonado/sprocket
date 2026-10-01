import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatGptStatus, DesktopApi } from '$lib/types/sprocket';
import { useChatGptStatus } from './use-chatgpt-status';

const connected: ChatGptStatus = {
	accounts: [{ connectionId: 'account-a', label: 'Account A', connected: true }],
	activeConnectionId: 'account-a',
	models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }],
	loginAvailable: true
};

const disconnected: ChatGptStatus = {
	accounts: [],
	activeConnectionId: null,
	models: [],
	loginAvailable: true
};

type HookContext = { userId: string | null };

function mount(fetchChatGptStatus: DesktopApi['fetchChatGptStatus']) {
	const api = { fetchChatGptStatus };
	const initialProps: HookContext = { userId: 'user-a' };

	return renderHook(({ userId }: HookContext) => useChatGptStatus(api, userId), {
		initialProps
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it('recovers from a failed initial request automatically', async () => {
	const fetchStatus = vi.fn(async () => connected).mockRejectedValueOnce(new Error('offline'));
	const { result } = mount(fetchStatus);
	await act(async () => {});
	expect(result.current).toMatchObject({ status: null, loading: false, error: 'offline' });
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60_000);
	});
	expect(result.current).toMatchObject({ status: connected, loading: false, error: null });
});

it('retains the last successful status on transport failure and refreshes on return', async () => {
	const changed = { ...connected, models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }] };

	const fetchStatus = vi
		.fn(async () => changed)
		.mockResolvedValueOnce(connected)
		.mockRejectedValueOnce(new Error('server unavailable'));

	const { result } = mount(fetchStatus);
	await act(async () => {});
	await act(async () => {
		window.dispatchEvent(new Event('focus'));
	});
	expect(result.current).toMatchObject({ status: connected, error: 'server unavailable' });
	await act(async () => {
		window.dispatchEvent(new Event('online'));
	});
	expect(result.current).toMatchObject({ status: changed, error: null });
});

it('coalesces refresh events and pauses polling while the window is hidden', async () => {
	const pending = Promise.withResolvers<ChatGptStatus>();
	const fetchStatus = vi.fn(async () => connected).mockReturnValueOnce(pending.promise);
	mount(fetchStatus);
	act(() => {
		window.dispatchEvent(new Event('focus'));
		window.dispatchEvent(new Event('online'));
		document.dispatchEvent(new Event('visibilitychange'));
	});
	expect(fetchStatus).toHaveBeenCalledTimes(1);
	await act(async () => pending.resolve(connected));
	vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
	await act(async () => {
		await vi.advanceTimersByTimeAsync(120_000);
	});
	expect(fetchStatus).toHaveBeenCalledTimes(1);
	vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
	await act(async () => {
		document.dispatchEvent(new Event('visibilitychange'));
	});
	expect(fetchStatus).toHaveBeenCalledTimes(2);
});

it('keeps a published account change newer than an in-flight background status', async () => {
	const pending = Promise.withResolvers<ChatGptStatus>();
	const fetchStatus = vi.fn(() => pending.promise);
	const { result } = mount(fetchStatus);
	act(() => result.current.publish(connected));
	await act(async () => pending.resolve(disconnected));
	expect(result.current.status).toEqual(connected);
});

it('isolates users and aborts requests when the account changes or the hook unmounts', async () => {
	const pending = Promise.withResolvers<ChatGptStatus>();
	const fetchStatus = vi.fn<DesktopApi['fetchChatGptStatus']>(async () => disconnected);
	fetchStatus.mockReturnValueOnce(pending.promise);
	const { result, rerender, unmount } = mount(fetchStatus);
	const oldPublish = result.current.publish;
	const firstSignal = fetchStatus.mock.calls[0][1];
	rerender({ userId: 'user-b' });
	expect(firstSignal?.aborted).toBe(true);
	await act(async () => {
		oldPublish(connected);
		pending.resolve(connected);
	});
	expect(result.current.status).toEqual(disconnected);
	expect(fetchStatus.mock.calls[1][0]).toEqual({ userId: 'user-b' });
	const secondSignal = fetchStatus.mock.calls[1][1];
	rerender({ userId: null });
	expect(result.current).toMatchObject({ status: null, loading: false, error: null });
	expect(secondSignal?.aborted).toBe(true);
	unmount();
});

it('times out a stalled request and retries without manual intervention', async () => {
	const fetchStatus = vi.fn<DesktopApi['fetchChatGptStatus']>(async () => connected);
	fetchStatus.mockImplementationOnce(
		(_request, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
			})
	);
	const { result } = mount(fetchStatus);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30_000);
	});
	expect(result.current.loading).toBe(false);
	expect(result.current.error).toContain('timed out');
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60_000);
	});
	expect(result.current).toMatchObject({ status: connected, error: null });
});
