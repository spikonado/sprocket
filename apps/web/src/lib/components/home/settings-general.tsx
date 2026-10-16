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

	const setAutomaticAgentContinuation = useMutation(
		api.uiPreferences.setAutomaticAgentContinuation
	);

	const preferences = preferencesQuery.status === 'success' ? preferencesQuery.data : null;
	const disabled = preferencesQuery.status !== 'success';

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">General</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-4">
					<PreferenceToggle
						title="Automatically name threads"
						description="Name threads after the first user prompt."
						descriptionId="automatic-thread-titles-description"
						savedEnabled={preferences?.automaticThreadTitles ?? true}
						disabled={disabled}
						save={setAutomaticThreadTitles}
					/>
					<PreferenceToggle
						title="Continue agents automatically after restarts"
						description="Automatically resume interrupted agents after an update, crash, or machine restart."
						descriptionId="automatic-agent-continuation-description"
						savedEnabled={preferences?.automaticAgentContinuation ?? true}
						disabled={disabled}
						save={setAutomaticAgentContinuation}
					/>
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
				</div>
			</div>
		</section>
	);
}

function PreferenceToggle({
	title,
	description,
	descriptionId,
	savedEnabled,
	disabled,
	save
}: {
	title: string;
	description: string;
	descriptionId: string;
	savedEnabled: boolean;
	disabled: boolean;
	save: (args: { enabled: boolean }) => Promise<null>;
}) {
	const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const enabled = pendingEnabled ?? savedEnabled;
	const saving = pendingEnabled !== null;

	async function toggle() {
		if (disabled || saving) return;
		const nextEnabled = !enabled;
		setPendingEnabled(nextEnabled);
		setSaveError(null);

		try {
			await save({ enabled: nextEnabled });
		} catch {
			setSaveError("Couldn't save your preference. Try again.");
		} finally {
			setPendingEnabled(null);
		}
	}

	return (
		<div>
			<button
				type="button"
				role="switch"
				aria-checked={enabled}
				aria-label={title}
				aria-describedby={descriptionId}
				disabled={disabled || saving}
				className="focus-visible:ring-ring/60 text-foreground hover:bg-hover-fill flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2 disabled:cursor-wait disabled:opacity-50"
				onClick={() => void toggle()}
			>
				<span className="flex-1">
					<span className="block font-medium">{title}</span>
					<span id={descriptionId} className="text-muted-foreground mt-1 block text-[13px]">
						{description}
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
			{saveError && (
				<p role="alert" className="text-destructive px-3 text-sm">
					{saveError}
				</p>
			)}
		</div>
	);
}
