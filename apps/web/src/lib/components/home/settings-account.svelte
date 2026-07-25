<script lang="ts">
	import { LogOut } from '@lucide/svelte';
	import type { User } from '@workos-inc/authkit-js';
	import { useAuth, useQuery } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import { tierLabels } from '$convex/lib/tiers';
	import Button from '$lib/components/ui/button/button.svelte';
	import type { SprocketTheme } from '$lib/theme';
	import { cn } from '$lib/utils';

	type Props = {
		user: User | null;
		theme: SprocketTheme;
		onThemeChange: (theme: SprocketTheme) => void;
		onSignOut: () => void;
	};

	let { user, theme, onThemeChange, onSignOut }: Props = $props();
	let emailRevealed = $state(false);

	const convexAuth = useAuth();
	const subscriptionQuery = useQuery(api.billing.getMySubscription, () =>
		convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	);

	const displayName = $derived(
		[user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || null
	);

	const themeOptions: ReadonlyArray<{ id: SprocketTheme; label: string }> = [
		{ id: 'light', label: 'Light' },
		{ id: 'dark', label: 'Dark' }
	];
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
					Appearance
				</p>
				<p class="text-muted-foreground mt-2 text-sm leading-6">
					Choose the workspace theme. Sign-in and pairing screens always stay light.
				</p>
				<div
					class="border-border bg-muted/60 mt-4 inline-flex rounded-full border p-1"
					role="group"
					aria-label="Workspace theme"
				>
					{#each themeOptions as option (option.id)}
						<button
							type="button"
							class={cn(
								'rounded-full px-4 py-1.5 text-sm font-medium transition',
								theme === option.id
									? 'bg-primary text-primary-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground'
							)}
							aria-pressed={theme === option.id}
							onclick={() => onThemeChange(option.id)}
						>
							{option.label}
						</button>
					{/each}
				</div>
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
					<div
						class="mt-3.5 h-4 w-16 animate-pulse rounded bg-[var(--hover-fill)]"
						aria-hidden="true"
					></div>
				{/if}
			</div>

			<div>
				<p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
					Session
				</p>
				<p class="text-muted-foreground mt-2 text-sm leading-6">
					Sign out of this device. You’ll need to authenticate again to open your workspace.
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
