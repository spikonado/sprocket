<script lang="ts">
	import logo from '@/assets/logo.svg';
	import github from '@/assets/github_logo.svg';
	import { lockOverlay } from '@/lib/focus-trap';
	import { SPROCKET_GITHUB_URL } from '@/lib/sprocket-releases';
	import { marketingBrandClass, marketingButtonPrimaryClass } from '@/styles/marketing';
	import { cn } from '@/utils';

	const navLinks = [
		{ label: 'Home', href: '/' },
		{ label: 'Pricing', href: '/pricing' }
	] as const;

	let menuOpen = $state(false);
	let menuButton: HTMLButtonElement | undefined = $state();

	function closeMenu() {
		menuOpen = false;
	}

	function toggleMenu() {
		menuOpen = !menuOpen;
	}
</script>

<header
	{@attach menuOpen && lockOverlay(closeMenu)}
	class="border-border/40 bg-background/95 fixed top-0 z-50 w-full border-b"
	data-ph-capture-attribute-section="navbar"
>
	<div
		class="relative mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8"
	>
		<a
			href="/"
			class="group flex min-w-0 items-center gap-2 transition-transform duration-150 hover:scale-[1.02]"
			onclick={closeMenu}
		>
			<img src={logo.src} alt="" class="h-8 w-8 shrink-0" />
			<span class={cn(marketingBrandClass, 'truncate text-xl sm:text-2xl')}>Sprocket</span>
		</a>

		<nav
			class="absolute left-1/2 hidden -translate-x-1/2 items-center gap-6 md:flex"
			aria-label="Primary"
		>
			{#each navLinks as link (link.label)}
				<a
					href={link.href}
					class="text-muted-foreground hover:text-foreground font-sans text-sm font-medium transition-colors"
				>
					{link.label}
				</a>
			{/each}
		</nav>

		<div class="flex shrink-0 items-center gap-2 sm:gap-3">
			<a
				href={SPROCKET_GITHUB_URL}
				target="_blank"
				rel="noopener noreferrer"
				class="border-border bg-surface text-foreground hover:bg-accent-soft hidden items-center gap-2 rounded-lg border px-2.5 py-1.5 font-sans text-sm font-medium shadow-sm transition-colors md:inline-flex"
			>
				<img src={github.src} alt="" class="h-4 w-4" />
				<span>GitHub</span>
			</a>
			<a
				href="/#download"
				class={cn(marketingButtonPrimaryClass, 'hidden text-sm whitespace-nowrap md:inline-flex')}
			>
				Download
			</a>

			<button
				bind:this={menuButton}
				type="button"
				class="border-border bg-surface text-foreground hover:bg-accent-soft focus-visible:ring-ring/50 inline-flex h-10 w-10 items-center justify-center rounded-lg border transition-colors focus-visible:ring-2 focus-visible:outline-none md:hidden"
				aria-label={menuOpen ? 'Close menu' : 'Open menu'}
				aria-expanded={menuOpen}
				aria-controls="mobile-nav"
				onclick={toggleMenu}
			>
				{#if menuOpen}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						class="h-5 w-5"
						aria-hidden="true"
					>
						<path d="M6 6l12 12M18 6L6 18" />
					</svg>
				{:else}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						class="h-5 w-5"
						aria-hidden="true"
					>
						<path d="M4 7h16M4 12h16M4 17h16" />
					</svg>
				{/if}
			</button>
		</div>
	</div>

	{#if menuOpen}
		<div
			id="mobile-nav"
			class="border-border/40 bg-background border-t md:hidden"
			role="dialog"
			aria-modal="true"
			aria-label="Site navigation"
			tabindex="-1"
			data-ph-capture-attribute-section="navbar_mobile"
		>
			<nav class="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-4 sm:px-6" aria-label="Mobile">
				{#each navLinks as link (link.label)}
					<a
						href={link.href}
						class="text-foreground hover:bg-accent-soft rounded-xl px-3 py-3 font-sans text-base font-medium transition-colors"
						onclick={closeMenu}
					>
						{link.label}
					</a>
				{/each}

				<div class="border-border/50 mt-3 flex flex-col gap-3 border-t pt-4">
					<a
						href={SPROCKET_GITHUB_URL}
						target="_blank"
						rel="noopener noreferrer"
						class="border-border bg-surface text-foreground hover:bg-accent-soft inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-3 font-sans text-base font-medium transition-colors"
						onclick={closeMenu}
					>
						<img src={github.src} alt="" class="h-5 w-5" />
						<span>GitHub</span>
					</a>
					<a
						href="/#download"
						class={cn(marketingButtonPrimaryClass, 'w-full py-3 text-base')}
						onclick={closeMenu}
					>
						Download
					</a>
				</div>
			</nav>
		</div>
	{/if}
</header>
