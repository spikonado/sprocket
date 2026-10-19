import { useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { DragDropProvider } from '@dnd-kit/react';
import { useSortable } from '@dnd-kit/react/sortable';
import { move } from '@dnd-kit/helpers';
import { RestrictToElement } from '@dnd-kit/dom/modifiers';
import {
	useConvexAuth,
	useMutation,
	useQuery_experimental as useConvexQueryResult
} from 'convex/react';
import { api } from '@convex/_generated/api';
import { resolveProviderOrder, type ProviderOrderEntry } from '@convex/lib/providerOrder';
import type { CompletionProvider } from '@convex/lib/validators';
import { completionProviderLabels, reorderShownProviders } from '$lib/chat/providers';
import PreferenceToggle, { SwitchTrack } from '$lib/components/home/preference-toggle';
import ProviderLogo from '$lib/components/provider-logo';

function ProviderRow({
	entry,
	index,
	disabled,
	lastEnabled,
	onToggle
}: {
	entry: ProviderOrderEntry;
	index: number;
	disabled: boolean;
	lastEnabled: boolean;
	onToggle: () => void;
}) {
	const { ref, handleRef, isDragging } = useSortable({ id: entry.provider, index, disabled });
	const label = completionProviderLabels[entry.provider];

	return (
		<li
			ref={ref}
			className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${
				isDragging ? 'bg-hover-fill shadow-lg' : 'hover:bg-hover-fill'
			}`}
		>
			<button
				ref={handleRef}
				type="button"
				aria-label={`Reorder ${label}`}
				disabled={disabled}
				className="text-muted-foreground enabled:hover:text-foreground -ml-1 flex size-6 touch-none items-center justify-center rounded-md enabled:cursor-grab enabled:active:cursor-grabbing"
			>
				<GripVertical className="size-4" aria-hidden="true" />
			</button>
			<ProviderLogo provider={entry.provider} className="size-5" />
			<p className="text-foreground min-w-0 flex-1 font-medium">{label}</p>
			<button
				type="button"
				role="switch"
				aria-checked={entry.enabled}
				aria-label={label}
				title={lastEnabled ? 'Keep at least one provider on.' : undefined}
				disabled={disabled || lastEnabled}
				className="focus-visible:ring-ring/60 rounded-full outline-none focus-visible:ring-2 enabled:cursor-pointer disabled:opacity-50"
				onClick={onToggle}
			>
				<SwitchTrack enabled={entry.enabled} />
			</button>
		</li>
	);
}

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
	const listRef = useRef<HTMLOListElement>(null);
	const preferences = preferencesQuery.status === 'success' ? preferencesQuery.data : null;
	const disabled = preferencesQuery.status !== 'success';
	const order = pendingOrder ?? resolveProviderOrder(preferences?.providerOrder);
	const shown = order.filter((entry) => configuredProviders.includes(entry.provider));
	const shownEnabledCount = shown.filter((entry) => entry.enabled).length;

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

	function toggle(provider: CompletionProvider) {
		void save(
			order.map((entry) =>
				entry.provider === provider ? { ...entry, enabled: !entry.enabled } : entry
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
					<p className="text-muted-foreground px-3 pb-3 text-sm leading-6">
						Agents use the first enabled provider that offers the model and fall back to the next
						one if it fails. Drag to reorder.
					</p>

					<DragDropProvider
						modifiers={[RestrictToElement.configure({ element: () => listRef.current })]}
						onDragEnd={(event) => {
							if (event.canceled) return;

							const shownOrder = move(
								shown.map((entry) => entry.provider),
								event
							);

							if (shownOrder.every((provider, index) => provider === shown[index].provider)) {
								return;
							}

							void save(reorderShownProviders(order, shownOrder));
						}}
					>
						<ol ref={listRef} className="space-y-1" aria-label="Provider order">
							{shown.map((entry, index) => (
								<ProviderRow
									key={entry.provider}
									entry={entry}
									index={index}
									disabled={disabled}
									lastEnabled={entry.enabled && shownEnabledCount === 1}
									onToggle={() => toggle(entry.provider)}
								/>
							))}
						</ol>
					</DragDropProvider>
					{shown.length < order.length && (
						<p className="text-muted-foreground px-3 text-[13px]">
							<button
								type="button"
								className="text-foreground cursor-pointer underline underline-offset-2"
								onClick={onOpenCredentials}
							>
								Set up more providers in BYOK/BYOS
							</button>
						</p>
					)}
					{saveError && (
						<p role="alert" className="text-destructive px-3 text-sm">
							{saveError}
						</p>
					)}

					<PreferenceToggle
						title="Restrict subagents to the parent's provider"
						description="When off, agents can delegate to models from any enabled provider. When on, subagents only use models from the provider running the parent agent."
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
