import { ExternalLink, LoaderCircle, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

export type TscircuitApi = Pick<LocalApi, 'startTscircuit'>;

type Props = {
	api: TscircuitApi | null;
	file: WorkspaceFileTarget;
};

type Status =
	{ kind: 'starting' } | { kind: 'ready'; url: string } | { kind: 'error'; message: string };

const ICON_LINK = 'text-muted-foreground hover:text-foreground rounded-md p-1 transition';

export default function TscircuitView({ api, file }: Props) {
	const [status, setStatus] = useState<Status>({ kind: 'starting' });
	const [attempt, setAttempt] = useState(0);
	const { workspacePath, path } = file;

	useEffect(() => {
		if (!api) return;
		const controller = new AbortController();
		setStatus({ kind: 'starting' });
		api.startTscircuit({ workspacePath, path }, controller.signal).then(
			(url) => {
				if (!controller.signal.aborted) setStatus({ kind: 'ready', url });
			},
			(error: unknown) => {
				if (controller.signal.aborted) return;
				setStatus({
					kind: 'error',
					message: error instanceof Error ? error.message : 'Couldn’t start tscircuit.'
				});
			}
		);

		return () => controller.abort();
	}, [api, workspacePath, path, attempt]);

	if (!api) {
		return (
			<p role="status" className="text-muted-foreground p-6 text-center text-sm">
				Connect to the local Sprocket server to use tscircuit.
			</p>
		);
	}

	if (status.kind !== 'ready') {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
				{status.kind === 'starting' ? (
					<>
						<LoaderCircle
							className="text-muted-foreground size-5 animate-spin"
							aria-hidden="true"
						/>
						<p role="status" className="text-muted-foreground text-sm">
							Starting tscircuit…
						</p>
					</>
				) : (
					<>
						<p role="alert" className="text-destructive text-sm whitespace-pre-wrap">
							{status.message}
						</p>
						<button
							type="button"
							className="hover:bg-muted rounded-md border px-3 py-1.5 text-xs font-medium transition"
							onClick={() => setAttempt((value) => value + 1)}
						>
							Retry
						</button>
					</>
				)}
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-2 border-b px-3 py-1.5">
				<span className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={path}>
					{path}
				</span>
				<button
					type="button"
					onClick={() => setAttempt((value) => value + 1)}
					className={ICON_LINK}
					aria-label="Reload tscircuit"
					title="Reload tscircuit"
				>
					<RotateCw className="size-3.5" aria-hidden="true" />
				</button>
				<a
					href={status.url}
					target="_blank"
					rel="noopener noreferrer"
					className={ICON_LINK}
					aria-label="Open tscircuit in a new tab"
					title="Open tscircuit in a new tab"
				>
					<ExternalLink className="size-3.5" aria-hidden="true" />
				</a>
			</div>
			<iframe
				key={attempt}
				src={status.url}
				title="tscircuit editor"
				className="min-h-0 w-full flex-1 border-0"
			/>
		</div>
	);
}
