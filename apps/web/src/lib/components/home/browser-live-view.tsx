import { ExternalLink, Globe, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrowserStatus, DesktopApi } from '$lib/types/sprocket';

export type BrowserApi = Pick<
	DesktopApi,
	'fetchBrowserStatus' | 'startBrowser' | 'browserDashboardUrl'
>;

type Props = {
	browserApi: BrowserApi | null;
};

export default function BrowserLiveView({ browserApi }: Props) {
	const [status, setStatus] = useState<BrowserStatus>({ state: 'installing', error: null });
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!browserApi) return;

		const api = browserApi;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		setStatus({ state: 'installing', error: null });

		async function refresh(start: boolean) {
			try {
				const next = await (start
					? api.startBrowser(controller.signal)
					: api.fetchBrowserStatus(controller.signal));

				if (controller.signal.aborted) return;
				setStatus(next);

				if (next.state !== 'error') {
					timer = setTimeout(() => void refresh(false), next.state === 'installing' ? 1000 : 5000);
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				setStatus({
					state: 'error',
					error: error instanceof Error ? error.message : 'Couldn’t set up the browser.'
				});
			}
		}

		void refresh(true);

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
