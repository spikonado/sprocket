import { z } from 'zod';

type ImageWatch = {
	revision?: string | null;
	listeners: Set<(url: string) => void>;
};

const watches = new Map<string, ImageWatch>();

const revisionSchema = z.string().nullable();

const POLL_INTERVAL_MS = 2_000;

let timer: ReturnType<typeof setTimeout> | undefined;

let controller: AbortController | undefined;

function schedule() {
	if (watches.size && !timer && !controller) timer = setTimeout(poll, POLL_INTERVAL_MS);
}

async function poll() {
	timer = undefined;

	if (document.visibilityState === 'hidden') {
		schedule();

		return;
	}

	const current = new AbortController();
	controller = current;
	const pending = [...watches.entries()];

	async function worker() {
		while (pending.length && !current.signal.aborted) {
			const next = pending.shift();

			if (!next) return;
			const [source, watch] = next;

			if (watches.get(source) !== watch) continue;
			const url = new URL(source, window.location.href);
			url.searchParams.set('revisionOnly', 'true');

			try {
				const response = await fetch(url.href, {
					credentials: 'include',
					cache: 'no-store',
					signal: AbortSignal.any([current.signal, AbortSignal.timeout(5_000)])
				});

				if (!response.ok) continue;
				const revision = revisionSchema.parse(await response.json());

				if (current.signal.aborted || watches.get(source) !== watch) continue;

				if (revision === watch.revision) continue;
				watch.revision = revision;

				if (revision === null) continue;
				url.searchParams.delete('revisionOnly');
				url.searchParams.set('revision', revision);

				for (const listener of watch.listeners) listener(url.href);
			} catch {
				// Keep the last rendered image during disconnects and retry on the next poll.
			}
		}
	}

	try {
		await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));
	} finally {
		if (controller === current) controller = undefined;
		schedule();
	}
}

/** Share metadata checks across every rendered reference to the same local image. */
export function watchMarkdownImage(source: string, listener: (url: string) => void) {
	let watch = watches.get(source);

	if (!watch) {
		watch = { listeners: new Set() };
		watches.set(source, watch);
	}

	watch.listeners.add(listener);

	if (watch.revision) {
		const url = new URL(source, window.location.href);
		url.searchParams.set('revision', watch.revision);
		listener(url.href);
	}

	schedule();

	return () => {
		watch.listeners.delete(listener);

		if (!watch.listeners.size) watches.delete(source);

		if (!watches.size) {
			clearTimeout(timer);
			timer = undefined;
			controller?.abort();
		}
	};
}
