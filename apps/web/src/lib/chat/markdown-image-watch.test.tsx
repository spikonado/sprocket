import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchMarkdownImage } from './markdown-image-watch';

const source = '/api/workspace/image?path=%2Ftmp%2Fboard.png';

const stops: (() => void)[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function response(revision: string | null) {
	return new Response(JSON.stringify(revision), {
		headers: { 'content-type': 'application/json' }
	});
}

it('shares checks and refreshes only when the file revision changes', async () => {
	const fetch = vi
		.fn<(url: string, options: RequestInit) => Promise<Response>>()
		.mockResolvedValueOnce(response('100-1'))
		.mockResolvedValueOnce(response('100-1'))
		.mockResolvedValueOnce(response('100-2'));

	vi.stubGlobal('fetch', fetch);
	const first = vi.fn();
	const second = vi.fn();
	stops.push(watchMarkdownImage(source, first), watchMarkdownImage(source, second));
	await vi.advanceTimersByTimeAsync(2_000);
	expect(fetch).toHaveBeenCalledTimes(1);
	const [url, options] = fetch.mock.calls[0];
	expect(new URL(url).searchParams.get('revisionOnly')).toBe('true');
	expect(options.credentials).toBe('include');
	expect(first.mock.calls[0][0]).toBe(second.mock.calls[0][0]);
	await vi.advanceTimersByTimeAsync(2_000);
	expect(first).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(2_000);
	expect(first).toHaveBeenCalledTimes(2);
	expect(new URL(first.mock.calls[1][0]).searchParams.get('revision')).toBe('100-2');
	expect(second).toHaveBeenCalledTimes(2);
});

it('retries disconnects and missing files, including a file restored with the same revision', async () => {
	const fetch = vi
		.fn<(url: string, options: RequestInit) => Promise<Response>>()
		.mockResolvedValueOnce(response('100-1'))
		.mockRejectedValueOnce(new Error('Offline'))
		.mockResolvedValueOnce(response(null))
		.mockResolvedValueOnce(response('100-1'));

	vi.stubGlobal('fetch', fetch);
	const listener = vi.fn();
	stops.push(watchMarkdownImage(source, listener));
	await vi.advanceTimersByTimeAsync(6_000);
	expect(listener).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(2_000);
	expect(listener).toHaveBeenCalledTimes(2);
});

it('pauses checks in hidden tabs and stops when the last subscriber leaves', async () => {
	const fetch = vi.fn().mockImplementation(async () => response('100-1'));
	vi.stubGlobal('fetch', fetch);
	vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
	const stop = watchMarkdownImage(source, vi.fn());
	await vi.advanceTimersByTimeAsync(4_000);
	expect(fetch).not.toHaveBeenCalled();
	vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
	await vi.advanceTimersByTimeAsync(2_000);
	expect(fetch).toHaveBeenCalledTimes(1);
	stop();
	await vi.advanceTimersByTimeAsync(4_000);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it('discards a response after unsubscribing and aborts the request', async () => {
	let finish: (value: Response) => void = () => {};

	const fetch = vi
		.fn<(url: string, options: RequestInit) => Promise<Response>>()
		.mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				})
		);

	vi.stubGlobal('fetch', fetch);
	const listener = vi.fn();
	const stop = watchMarkdownImage(source, listener);
	await vi.advanceTimersByTimeAsync(2_000);
	stop();
	expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
	finish(response('100-1'));
	await vi.advanceTimersByTimeAsync(0);
	expect(listener).not.toHaveBeenCalled();
});

it('limits simultaneous metadata requests to four without overlapping polling rounds', async () => {
	const finishes: ((response: Response) => void)[] = [];

	const fetch = vi.fn(
		() =>
			new Promise<Response>((resolve) => {
				finishes.push(resolve);
			})
	);

	vi.stubGlobal('fetch', fetch);

	for (let index = 0; index < 7; index += 1) {
		stops.push(watchMarkdownImage(`${source}&workspacePath=/workspace-${index}`, vi.fn()));
	}

	await vi.advanceTimersByTimeAsync(4_000);
	expect(fetch).toHaveBeenCalledTimes(4);

	for (const finish of finishes.splice(0)) finish(response('100-1'));
	await vi.advanceTimersByTimeAsync(0);
	expect(fetch).toHaveBeenCalledTimes(7);

	for (const finish of finishes.splice(0)) finish(response('100-1'));
	await vi.advanceTimersByTimeAsync(0);
});
