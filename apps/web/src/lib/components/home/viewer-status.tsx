export type ViewerStatus =
	{ kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

/** Covers the viewer until its first drawing, then sits over that drawing as a small notice. */
export default function ViewerStatusNotice({
	status,
	drawn,
	opening
}: {
	status: ViewerStatus;
	drawn: boolean;
	opening: string;
}) {
	if (status.kind === 'ready') return null;

	return (
		<div
			role={status.kind === 'error' ? 'alert' : 'status'}
			className={
				drawn
					? 'bg-background/80 text-muted-foreground border-hairline absolute bottom-3 left-1/2 z-10 max-w-[80%] -translate-x-1/2 truncate rounded-md border px-3 py-1.5 text-xs backdrop-blur'
					: 'bg-background text-muted-foreground absolute inset-0 z-10 flex items-center justify-center p-4 text-center text-sm'
			}
		>
			{status.kind === 'error' ? status.message : drawn ? 'Updating…' : opening}
		</div>
	);
}
