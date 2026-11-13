import { useRef, useState } from 'react';
import { GripVertical, Trash2 } from 'lucide-react';
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
import { builtInProvider, type ProviderOrderEntry } from '@convex/lib/providerOrder';
import type { CompletionProvider } from '@convex/lib/validators';
import { completionProviderLabels } from '$lib/chat/providers';
import { SwitchTrack } from '$lib/components/home/preference-toggle';
import ProviderLogo from '$lib/components/provider-logo';

type RemovalState = 'idle' | 'confirming' | 'removing';

// Sprocket holds no credential for these, so removing them would only hide a provider that's still signed in.
const unremovableProviders: readonly CompletionProvider[] = [builtInProvider, 'muse'];

function ProviderRow({
	entry,
	index,
	disabled,
	lastEnabled,
	removal,
	onToggle,
	onRemovalChange,
	onRemove
}: {
	entry: ProviderOrderEntry;
	index: number;
	disabled: boolean;
	lastEnabled: boolean;
	removal: RemovalState;
	onToggle: () => void;
	onRemovalChange: (removal: RemovalState) => void;
	onRemove: () => void;
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
				className="touch-target text-muted-foreground enabled:hover:text-foreground -ml-1 flex size-6 touch-none items-center justify-center rounded-md enabled:cursor-grab enabled:active:cursor-grabbing"
			>
				<GripVertical className="size-4" aria-hidden="true" />
			</button>
			<ProviderLogo provider={entry.provider} className="size-5" />
			<p className="text-foreground min-w-0 flex-1">{label}</p>
			{removal === 'idle' ? (
				<>
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
					{unremovableProviders.includes(entry.provider) ? (
						<span className="size-6" aria-hidden="true" />
					) : (
						<button
							type="button"
							aria-label={`Remove ${label}`}
							disabled={disabled}
							className="touch-target text-muted-foreground enabled:hover:text-destructive flex size-6 items-center justify-center rounded-md enabled:cursor-pointer disabled:opacity-50"
							onClick={() => onRemovalChange('confirming')}
						>
							<Trash2 className="size-4" aria-hidden="true" />
						</button>
					)}
				</>
			) : (
				<>
					<button
						type="button"
						disabled={removal === 'removing'}
						className="text-destructive text-[13px] enabled:cursor-pointer disabled:opacity-50"
						onClick={onRemove}
					>
						{removal === 'removing' ? 'Removing…' : 'Remove'}
					</button>
					<button
						type="button"
						disabled={removal === 'removing'}
						className="text-muted-foreground hover:text-foreground text-[13px] enabled:cursor-pointer disabled:opacity-50"
						onClick={() => onRemovalChange('idle')}
					>
						Cancel
					</button>
				</>
			)}
		</li>
	);
}

export default function SettingsProviders({
	onRemove,
	onOpenCredentials
}: {
	onRemove: (provider: CompletionProvider) => Promise<string | null>;
	onOpenCredentials: () => void;
}) {
	const convexAuth = useConvexAuth();

	const orderQuery = useConvexQueryResult({
		query: api.uiPreferences.getMyProviderOrder,
		args: convexAuth.isAuthenticated ? {} : 'skip'
	});

	const setProviderOrder = useMutation(api.uiPreferences.setProviderOrder).withOptimisticUpdate(
		(localStore, { providerOrder }) => {
			localStore.setQuery(api.uiPreferences.getMyProviderOrder, {}, providerOrder);
		}
	);

	const [removal, setRemoval] = useState<{
		provider: CompletionProvider;
		state: Exclude<RemovalState, 'idle'>;
	} | null>(null);

	const [removalWarning, setRemovalWarning] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const listRef = useRef<HTMLOListElement>(null);
	const disabled = orderQuery.status !== 'success' || removal?.state === 'removing';
	const order = orderQuery.status === 'success' ? orderQuery.data : [];
	const enabledCount = order.filter((entry) => entry.enabled).length;

	async function save(next: ProviderOrderEntry[]) {
		setSaveError(null);

		try {
			await setProviderOrder({ providerOrder: next });
		} catch {
			setSaveError("Couldn't save your providers. Try again.");
		}
	}

	async function remove(provider: CompletionProvider) {
		setRemoval({ provider, state: 'removing' });
		setRemovalWarning(null);
		setSaveError(null);

		try {
			setRemovalWarning(await onRemove(provider));
		} catch {
			setSaveError(`Couldn't remove ${completionProviderLabels[provider]}. Try again.`);
		} finally {
			setRemoval(null);
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
				<h1 className="text-foreground text-[1rem] tracking-[-0.03em]">Providers</h1>
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

							const providers = order.map((entry) => entry.provider);
							const moved = move(providers, event);

							if (moved.every((provider, index) => provider === providers[index])) return;

							void save(
								moved.flatMap((provider) => order.filter((entry) => entry.provider === provider))
							);
						}}
					>
						<ol ref={listRef} className="space-y-1" aria-label="Provider order">
							{order.map((entry, index) => (
								<ProviderRow
									key={entry.provider}
									entry={entry}
									index={index}
									disabled={disabled}
									lastEnabled={entry.enabled && enabledCount === 1}
									removal={removal?.provider === entry.provider ? removal.state : 'idle'}
									onToggle={() => toggle(entry.provider)}
									onRemovalChange={(state) =>
										setRemoval(state === 'idle' ? null : { provider: entry.provider, state })
									}
									onRemove={() => void remove(entry.provider)}
								/>
							))}
						</ol>
					</DragDropProvider>
					<p className="text-muted-foreground px-3 text-[13px]">
						<button
							type="button"
							className="text-foreground cursor-pointer underline underline-offset-2"
							onClick={onOpenCredentials}
						>
							Set up more providers in BYOK/BYOS
						</button>
					</p>
					{removalWarning && (
						<p role="status" className="text-muted-foreground px-3 text-sm">
							{removalWarning}
						</p>
					)}
					{saveError && (
						<p role="alert" className="text-destructive px-3 text-sm">
							{saveError}
						</p>
					)}
					{orderQuery.status === 'error' && (
						<p role="alert" className="text-destructive px-3 text-sm">
							Couldn't load your preferences right now.
						</p>
					)}
				</div>
			</div>
		</section>
	);
}
