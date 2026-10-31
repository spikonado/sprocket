import { ExternalLink, Globe, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrowserStatus, LocalApi } from '$lib/types/sprocket';

export type BrowserApi = Pick<
	LocalApi,
	'startBrowser' | 'watchBrowserStatus' | 'browserDashboardUrl'
>;

type Props = {
	browserApi: BrowserApi | null;
};

export default function BrowserView({ browserApi }: Props) {
	const [status, setStatus] = useState<BrowserStatus>({ state: 'installing', error: null });
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!browserApi) return;

		const api = browserApi;
		const controller = new AbortController();
		const { signal } = controller;
		let timer: ReturnType<typeof setTimeout> | undefined;
		setStatus({ state: 'installing', error: null });

		// Starting is a no-op while the dashboard runs, and relaunches it after a server restart.
		async function run() {
			let started: BrowserStatus;

			try {
				started = await api.startBrowser(signal);
			} catch (error) {
				if (signal.aborted) return;
				setStatus({
					state: 'error',
					error: error instanceof Error ? error.message : 'Couldn’t set up the browser.'
				});

				return;
			}

			if (signal.aborted) return;

			if (started.state === 'error') {
				setStatus(started);

				return;
			}

			await api.watchBrowserStatus({ signal, onEvent: setStatus }).catch(() => undefined);

			if (!signal.aborted) timer = setTimeout(() => void run(), 1000);
		}

		void run();

		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [browserApi, attempt]);

	if (!browserApi) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
				<Globe className="text-muted-foreground size-5" aria-hidden="true" />
				<p role="status" className="text-muted-foreground text-sm">
					Connect to the local Sprocket server to use the browser.
				</p>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{status.state === 'ready' ? (
				<>
					<div className="flex items-center gap-2 border-b px-3 py-1.5">
						<span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
						<span role="status" className="text-muted-foreground flex-1 text-xs">
							Browser ready
						</span>
						<a
							href={browserApi.browserDashboardUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="text-muted-foreground hover:text-foreground rounded-md p-1 transition"
							aria-label="Open browser dashboard in a new tab"
							title="Open browser dashboard in a new tab"
						>
							<ExternalLink className="size-3.5" aria-hidden="true" />
						</a>
					</div>
					<iframe
						src={browserApi.browserDashboardUrl}
						title="Agent browser dashboard"
						className="min-h-0 w-full flex-1 border-0"
						allow="clipboard-read; clipboard-write"
					/>
				</>
			) : (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
					{status.state === 'installing' ? (
						<>
							<LoaderCircle
								className="text-muted-foreground size-5 animate-spin"
								aria-hidden="true"
							/>
							<p role="status" className="text-muted-foreground text-sm">
								Setting up the browser…
							</p>
						</>
					) : (
						<>
							<p role="alert" className="text-destructive text-sm">
								{status.error || 'Couldn’t set up the browser.'}
							</p>
							<button
								type="button"
								className="hover:bg-muted rounded-md border px-3 py-1.5 text-xs font-medium transition"
								onClick={() => setAttempt((value) => value + 1)}
							>
								Retry setup
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}
