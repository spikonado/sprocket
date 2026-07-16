<script lang="ts">
	import { Archive, ArrowLeft, UserRound } from '@lucide/svelte';

	export type SettingsPage = 'account' | 'archived';

	type Props = {
		activePage: SettingsPage;
		onBack: () => void;
		onNavigate: (page: SettingsPage) => void;
	};

	let { activePage, onBack, onNavigate }: Props = $props();

	const navItemClass =
		'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition';
	const navItemActiveClass = 'bg-white/8 text-white';
	const navItemIdleClass = 'text-slate-300 hover:bg-white/5 hover:text-white';
</script>

<aside class="app-sidebar-panel">
	<div class="flex h-full min-h-0 flex-col overflow-hidden">
		<div class="px-3.5 pt-3 pb-3">
			<button
				type="button"
				class="inline-flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] text-slate-300 transition hover:bg-white/5 hover:text-white"
				onclick={onBack}
			>
				<ArrowLeft class="size-3.5" aria-hidden="true" />
				Back
			</button>
		</div>

		<nav
			class="hide-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-4"
			aria-label="Settings"
		>
			<button
				type="button"
				class={`${navItemClass} ${activePage === 'account' ? navItemActiveClass : navItemIdleClass}`}
				aria-current={activePage === 'account' ? 'page' : undefined}
				onclick={() => {
					onNavigate('account');
				}}
			>
				<UserRound class="size-4 shrink-0 text-slate-400" aria-hidden="true" />
				<span class="truncate">Account</span>
			</button>
			<button
				type="button"
				class={`${navItemClass} ${activePage === 'archived' ? navItemActiveClass : navItemIdleClass}`}
				aria-current={activePage === 'archived' ? 'page' : undefined}
				onclick={() => {
					onNavigate('archived');
				}}
			>
				<Archive class="size-4 shrink-0 text-slate-400" aria-hidden="true" />
				<span class="truncate">Archived Threads</span>
			</button>
		</nav>
	</div>
</aside>
