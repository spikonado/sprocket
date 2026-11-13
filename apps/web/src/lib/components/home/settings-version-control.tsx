import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import PreferenceToggle, { useMyPreferences } from '$lib/components/home/preference-toggle';

export default function SettingsVersionControl() {
	const { preferences, disabled, loadState } = useMyPreferences();
	const setCoAuthorCommits = useMutation(api.uiPreferences.setCoAuthorCommits);

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] tracking-[-0.03em]">Version Control</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-4">
					<PreferenceToggle
						title="Add Sprocket as a co-author on agent commits"
						savedEnabled={preferences?.coAuthorCommits ?? true}
						disabled={disabled}
						save={setCoAuthorCommits}
					/>
					{loadState}
				</div>
			</div>
		</section>
	);
}
