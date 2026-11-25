import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import PreferenceToggle, { useMyPreferences } from '$lib/components/home/preference-toggle';

export default function SettingsGeneral() {
	const { preferences, disabled, loadState } = useMyPreferences();

	const setAutomaticThreadTitles = useMutation(api.uiPreferences.setAutomaticThreadTitles);

	const setAutomaticAgentContinuation = useMutation(
		api.uiPreferences.setAutomaticAgentContinuation
	);

	const setSettleMergedThreads = useMutation(api.uiPreferences.setSettleMergedThreads);

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] tracking-[-0.03em]">General</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-4">
					<PreferenceToggle
						title="Automatically name threads"
						savedEnabled={preferences?.automaticThreadTitles ?? true}
						disabled={disabled}
						save={setAutomaticThreadTitles}
					/>
					<PreferenceToggle
						title="Continue agents automatically after restarts and crashes"
						savedEnabled={preferences?.automaticAgentContinuation ?? true}
						disabled={disabled}
						save={setAutomaticAgentContinuation}
					/>
					<PreferenceToggle
						title="Settle threads when their PRs merge"
						savedEnabled={preferences?.settleMergedThreads ?? false}
						disabled={disabled}
						save={setSettleMergedThreads}
					/>
					{loadState}
				</div>
			</div>
		</section>
	);
}
