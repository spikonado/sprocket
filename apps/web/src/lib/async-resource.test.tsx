import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAsyncResource } from './async-resource';

afterEach(() => vi.useRealTimers());

it('retries a failed load until it succeeds and starts over for a new key', async () => {
	vi.useFakeTimers();
	const error = new Error('offline');
	const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValue('ok');

	const { result, rerender } = renderHook((key: string) => useAsyncResource(key, load), {
		initialProps: 'user-a'
	});

	expect(result.current[0]).toEqual({ status: 'loading' });
	await act(() => vi.advanceTimersByTimeAsync(0));
	expect(result.current[0]).toEqual({ status: 'failed', error });
	await act(() => vi.advanceTimersByTimeAsync(1_000));
	expect(result.current[0]).toEqual({ status: 'loaded', value: 'ok' });

	rerender('user-b');
	expect(result.current[0]).toEqual({ status: 'loading' });
});

it('keeps a value set while a load is in flight', async () => {
	const pending = Promise.withResolvers<string>();
	const { result } = renderHook(() => useAsyncResource('user-a', () => pending.promise));

	act(() => result.current[1]('saved'));
	await act(async () => pending.resolve('stale'));
	expect(result.current[0]).toEqual({ status: 'loaded', value: 'saved' });
});
