import { useState } from 'react';
import {
	useConvexAuth,
	useMutation,
	useQuery_experimental as useConvexQueryResult
} from 'convex/react';
import { api } from '@convex/_generated/api';
import { cn } from '$lib/utils';

export default function SettingsGeneral() {
	const convexAuth = useConvexAuth();

	const preferencesQuery = useConvexQueryResult({
		query: api.uiPreferences.getMine,
		args: convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	});

	const setAutomaticThreadTitles = useMutation(api.uiPreferences.setAutomaticThreadTitles);
	const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);

	const enabled =
		pendingEnabled ??
		(preferencesQuery.status === 'success'
			? (preferencesQuery.data?.automaticThreadTitles ?? true)
			: true);

	const disabled = preferencesQuery.status !== 'success' || pendingEnabled !== null;

	async function toggleAutomaticThreadTitles() {
		if (disabled) return;
		const nextEnabled = !enabled;
		setPendingEnabled(nextEnabled);
		setSaveError(null);

		try {
			await setAutomaticThreadTitles({ enabled: nextEnabled });
		} catch {
			setSaveError("Couldn't save your preference. Try again.");
		} finally {
			setPendingEnabled(null);
		}
	}

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">General</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-4">
					<button
						type="button"
						role="switch"
						aria-checked={enabled}
						aria-label="Automatically name threads"
						aria-describedby="automatic-thread-titles-description"
						disabled={disabled}
						className="focus-visible:ring-ring/60 text-foreground hover:bg-hover-fill flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2 disabled:cursor-wait disabled:opacity-50"
						onClick={() => void toggleAutomaticThreadTitles()}
					>
						<span className="flex-1">
							<span className="block font-medium">Automatically name threads</span>
							<span
								id="automatic-thread-titles-description"
								className="text-muted-foreground mt-1 block text-[13px]"
							>
								Name and update threads after every user prompt.
							</span>
						</span>
						<span
							className={cn(
								'relative ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition',
								enabled ? 'bg-foreground' : 'bg-hover-fill-strong'
							)}
							aria-hidden="true"
						>
							<span
								className={cn(
									'bg-background inline-block size-3.5 rounded-full transition',
									enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
								)}
							/>
						</span>
					</button>
					{preferencesQuery.status === 'pending' && (
						<p role="status" className="text-muted-foreground px-3 text-sm">
							Loading preferences...
						</p>
					)}
					{preferencesQuery.status === 'error' && (
						<p role="alert" className="text-destructive px-3 text-sm">
							Couldn't load your preferences right now.
						</p>
					)}
					{saveError && (
						<p role="alert" className="text-destructive px-3 text-sm">
							{saveError}
						</p>
					)}
				</div>
			</div>
		</section>
	);
}
