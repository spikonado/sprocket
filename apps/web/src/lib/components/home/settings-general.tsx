import {
	useConvexAuth,
	useMutation,
	useQuery_experimental as useConvexQueryResult
} from 'convex/react';
import { api } from '@convex/_generated/api';
import PreferenceToggle from '$lib/components/home/preference-toggle';

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

	const setSettleMergedThreads = useMutation(api.uiPreferences.setSettleMergedThreads);

	const setShareConversationContent = useMutation(api.uiPreferences.setShareConversationContent);

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
					<PreferenceToggle
						title="Share conversation content"
						description="Include prompts and model output in analytics, and record session replays without masking text."
						savedEnabled={preferences?.shareConversationContent ?? true}
						disabled={disabled}
						save={setShareConversationContent}
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
