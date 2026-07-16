<script lang="ts">
	import { LogOut } from '@lucide/svelte';
	import type { User } from '@workos-inc/authkit-js';
	import Button from '$lib/components/ui/button/button.svelte';

	type Props = {
		user: User | null;
		onSignOut: () => void;
	};

	let { user, onSignOut }: Props = $props();
	let emailRevealed = $state(false);

	const displayName = $derived(
		[user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || null
	);
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden">
	<header class="flex h-12 shrink-0 items-center px-6">
		<h1 class="text-[1rem] font-medium tracking-[-0.03em] text-white">Account</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
		<div class="max-w-xl space-y-10">
			<div>
				<p class="text-[11px] tracking-[0.18em] text-slate-500 uppercase">Profile</p>
				{#if displayName || user?.email}
					<div class="mt-3 space-y-1">
						{#if displayName}
							<p class="text-[15px] text-white">{displayName}</p>
						{/if}
						{#if user?.email}
							<button
								type="button"
								class="block text-left text-sm text-slate-400 transition hover:text-slate-300"
								aria-pressed={emailRevealed}
								aria-label={emailRevealed ? 'Hide email address' : 'Show email address'}
								onclick={() => {
									emailRevealed = !emailRevealed;
								}}
							>
								<span class={emailRevealed ? undefined : 'select-none blur-[5px]'}>
									{user.email}
								</span>
							</button>
						{/if}
					</div>
				{:else}
					<p class="mt-3 text-sm text-slate-400">You’re signed in to Sprocket.</p>
				{/if}
			</div>

			<div>
				<p class="text-[11px] tracking-[0.18em] text-slate-500 uppercase">Session</p>
				<p class="mt-2 text-sm leading-6 text-slate-400">
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
