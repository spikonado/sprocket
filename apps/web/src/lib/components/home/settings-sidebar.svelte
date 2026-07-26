<script lang="ts">
	import { Archive, ArrowLeft, ChartNoAxesColumn, UserRound } from '@lucide/svelte';
	import SidebarTopActions from '$lib/components/home/sidebar-top-actions.svelte';
	import type { SprocketTheme } from '$lib/theme';

	export type SettingsPage = 'account' | 'usage' | 'archived';

	type Props = {
		activePage: SettingsPage;
		theme: SprocketTheme;
		onThemeChange: (theme: SprocketTheme) => void;
		onBack: () => void;
		onNavigate: (page: SettingsPage) => void;
	};

	let { activePage, theme, onThemeChange, onBack, onNavigate }: Props = $props();

	const navItems: ReadonlyArray<{ id: SettingsPage; label: string; icon: typeof UserRound }> = [
		{ id: 'account', label: 'Account', icon: UserRound },
		{ id: 'usage', label: 'Usage', icon: ChartNoAxesColumn },
		{ id: 'archived', label: 'Archived Threads', icon: Archive }
	];

	const navItemClass =
		'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition';
	const navItemActiveClass = 'bg-[var(--hover-fill-strong)] text-foreground';
	const navItemIdleClass =
		'text-muted-foreground hover:bg-[var(--hover-fill)] hover:text-foreground';
</script>

<aside class="app-sidebar-panel">
	<div class="flex h-full min-h-0 flex-col overflow-hidden">
		<div class="flex items-center justify-between gap-2 px-3.5 pt-3 pb-3">
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] transition hover:bg-[var(--hover-fill)]"
				onclick={onBack}
			>
				<ArrowLeft class="size-3.5" aria-hidden="true" />
				Back
			</button>
			<SidebarTopActions {theme} {onThemeChange} />
		</div>

		<nav
			class="hide-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-4"
			aria-label="Settings"
		>
			{#each navItems as item (item.id)}
				<button
					type="button"
					class={`${navItemClass} ${activePage === item.id ? navItemActiveClass : navItemIdleClass}`}
					aria-current={activePage === item.id ? 'page' : undefined}
					onclick={() => {
						onNavigate(item.id);
					}}
				>
					<item.icon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
					<span class="truncate">{item.label}</span>
				</button>
			{/each}
		</nav>
	</div>
</aside>
