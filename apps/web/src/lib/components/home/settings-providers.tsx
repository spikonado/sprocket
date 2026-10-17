import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
	useConvexAuth,
	useMutation,
	useQuery_experimental as useConvexQueryResult
} from 'convex/react';
import { api } from '@convex/_generated/api';
import { resolveProviderOrder, type ProviderOrderEntry } from '@convex/lib/providerOrder';
import type { CompletionProvider } from '@convex/lib/validators';
import { completionProviderLabels } from '$lib/chat/provider-chain';
import PreferenceToggle, { SwitchTrack } from '$lib/components/home/preference-toggle';
import ProviderLogo from '$lib/components/provider-logo';

const iconButtonClass =
	'text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-hover-fill flex size-7 items-center justify-center rounded-md transition enabled:cursor-pointer disabled:opacity-30';

export default function SettingsProviders({
	configuredProviders,
	onOpenCredentials
}: {
	configuredProviders: readonly CompletionProvider[];
	onOpenCredentials: () => void;
}) {
	const convexAuth = useConvexAuth();

	const preferencesQuery = useConvexQueryResult({
		query: api.uiPreferences.getMine,
		args: convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	});

	const setProviderOrder = useMutation(api.uiPreferences.setProviderOrder);

	const setRestrictSubagentsToProvider = useMutation(
		api.uiPreferences.setRestrictSubagentsToProvider
	);

	const [pendingOrder, setPendingOrder] = useState<ProviderOrderEntry[] | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const saveGeneration = useRef(0);
	const preferences = preferencesQuery.status === 'success' ? preferencesQuery.data : null;
	const disabled = preferencesQuery.status !== 'success';
	const order = pendingOrder ?? resolveProviderOrder(preferences?.providerOrder);
	const enabledCount = order.filter((entry) => entry.enabled).length;

	async function save(next: ProviderOrderEntry[]) {
		const generation = ++saveGeneration.current;
		setPendingOrder(next);
		setSaveError(null);

		try {
			await setProviderOrder({ providerOrder: next });
		} catch {
			if (generation === saveGeneration.current) {
				setSaveError("Couldn't save your providers. Try again.");
			}
		} finally {
			if (generation === saveGeneration.current) setPendingOrder(null);
		}
	}

	function move(index: number, offset: -1 | 1) {
		const next = [...order];
		[next[index], next[index + offset]] = [next[index + offset], next[index]];
		void save(next);
	}

	function toggle(index: number) {
		void save(
			order.map((entry, entryIndex) =>
				entryIndex === index ? { ...entry, enabled: !entry.enabled } : entry
			)
		);
	}

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Providers</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-4">
					<p className="text-muted-foreground px-3 text-sm leading-6">
						Runs use the first enabled provider that offers the model and fall back to the next one
						if it fails.
					</p>

					<ol className="space-y-1" aria-label="Provider order">
						{order.map((entry, index) => {
							const label = completionProviderLabels[entry.provider];
							const lastEnabled = entry.enabled && enabledCount === 1;
							const needsSetup = entry.enabled && !configuredProviders.includes(entry.provider);

							return (
								<li
									key={entry.provider}
									className="hover:bg-hover-fill flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm"
								>
									<ProviderLogo provider={entry.provider} className="size-5" />
									<div className="min-w-0 flex-1">
										<p className="text-foreground font-medium">{label}</p>
										{needsSetup && (
											<p className="text-muted-foreground mt-0.5 text-[13px]">
												Not set up yet, so runs skip it.{' '}
												<button
													type="button"
													className="text-foreground cursor-pointer underline underline-offset-2"
													onClick={onOpenCredentials}
												>
													Set up in BYOK/BYOS
												</button>
											</p>
										)}
									</div>
									<button
										type="button"
										className={iconButtonClass}
										aria-label={`Move ${label} up`}
										disabled={disabled || index === 0}
										onClick={() => move(index, -1)}
									>
										<ChevronUp className="size-4" aria-hidden="true" />
									</button>
									<button
										type="button"
										className={iconButtonClass}
										aria-label={`Move ${label} down`}
										disabled={disabled || index === order.length - 1}
										onClick={() => move(index, 1)}
									>
										<ChevronDown className="size-4" aria-hidden="true" />
									</button>
									<button
										type="button"
										role="switch"
										aria-checked={entry.enabled}
										aria-label={label}
										title={lastEnabled ? 'Keep at least one provider on.' : undefined}
										disabled={disabled || lastEnabled}
										className="focus-visible:ring-ring/60 ml-1 rounded-full outline-none focus-visible:ring-2 enabled:cursor-pointer disabled:opacity-50"
										onClick={() => toggle(index)}
									>
										<SwitchTrack enabled={entry.enabled} />
									</button>
								</li>
							);
						})}
					</ol>
					{saveError && (
						<p role="alert" className="text-destructive px-3 text-sm">
							{saveError}
						</p>
					)}

					<PreferenceToggle
						title="Restrict subagents to the parent's provider"
						description="When off, agents can delegate to models from any enabled provider. When on, subagents only use models from the provider running the parent agent."
						descriptionId="restrict-subagents-to-provider-description"
						savedEnabled={preferences?.restrictSubagentsToProvider ?? false}
						disabled={disabled}
						save={setRestrictSubagentsToProvider}
					/>
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
