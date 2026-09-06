<script lang="ts">
	import { LogOut } from '@lucide/svelte';
	import { useAuth, useQuery } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import { tierLabels } from '$convex/lib/tiers';
	import type { AuthUser } from '$lib/auth';
	import Button from '$lib/components/ui/button/button.svelte';

	type Props = {
		user: AuthUser | null;
		onSignOut: () => void;
	};

	let { user, onSignOut }: Props = $props();
	let emailRevealed = $state(false);

	const convexAuth = useAuth();
	const subscriptionQuery = useQuery(api.billing.getMySubscription, () =>
		convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	);

	const displayName = $derived(
		[user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || null
	);
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden">
	<header class="flex h-12 shrink-0 items-center px-6">
		<h1 class="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Account</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
		<div class="max-w-xl space-y-10">
			<div>
				<p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
					Profile
				</p>
				{#if displayName || user?.email}
					<div class="mt-3 space-y-1">
						{#if displayName}
							<p class="text-foreground text-[15px]">{displayName}</p>
						{/if}
						{#if user?.email}
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground block text-left text-sm transition"
								aria-pressed={emailRevealed}
								aria-label={emailRevealed ? 'Hide email address' : 'Show email address'}
								onclick={() => {
									emailRevealed = !emailRevealed;
								}}
							>
								<span class={emailRevealed ? undefined : 'blur-[5px] select-none'}>
									{user.email}
								</span>
							</button>
						{/if}
					</div>
				{:else}
					<p class="text-muted-foreground mt-3 text-sm">You’re signed in to Sprocket.</p>
				{/if}
			</div>

			<div>
				<p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
					Spikonado Subscription Tier
				</p>
				{#if subscriptionQuery.data}
					<p class="text-foreground mt-3 text-[15px]">{tierLabels[subscriptionQuery.data.tier]}</p>
				{:else if subscriptionQuery.error}
					<p class="text-muted-foreground mt-3 text-sm">
						Couldn’t load your subscription right now.
					</p>
				{:else}
					<div class="bg-hover-fill mt-3.5 h-4 w-16 animate-pulse rounded" aria-hidden="true"></div>
				{/if}
			</div>

			<div>
				<p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
					Session
				</p>
				<p class="text-muted-foreground mt-2 text-sm leading-6">
					Sign out of this device. You’ll need to authenticate again to open your projects.
				</p>
				<div class="mt-4">
					<Button variant="outline" onclick={onSignOut}>
						<LogOut class="mr-2 size-4" aria-hidden="true" />
						Sign Out
					</Button>
				</div>
			</div>
		</div>
	</div>
</section>
