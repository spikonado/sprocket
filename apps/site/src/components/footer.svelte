<script lang="ts">
	import logo from '@/assets/logo.svg';
	import github_logo from '@/assets/github_logo.svg';
	import x_logo from '@/assets/x_logo.svg';
	import youtube_logo from '@/assets/youtube_logo.svg';
	import instagram_logo from '@/assets/instagram_logo.svg';
	import facebook_logo from '@/assets/facebook_logo.svg';
	import { cn } from '@/utils';
	import {
		marketingBrandClass,
		marketingSectionBodyClass,
		marketingSectionShellClass
	} from '@/styles/marketing';

	const productLinks = [
		{ label: 'Sprocket', path: '/sprocket' },
		{ label: 'Vario', path: '/#vario' }
	] as const;

	const companyLinks = [
		{ label: 'Pricing', path: '/pricing' },
		{ label: 'Build log', path: '/#build-log' },
		{ label: 'Privacy Policy', path: '/privacy' }
	] as const;

	const socialLinks = [
		{ label: 'GitHub', href: 'https://github.com/spikonado', src: github_logo.src },
		{ label: 'X', href: 'https://x.com/spikonado', src: x_logo.src },
		{ label: 'YouTube', href: 'https://youtube.com/spikonado', src: youtube_logo.src },
		{ label: 'Instagram', href: 'https://instagram.com/spikonado', src: instagram_logo.src },
		{ label: 'Facebook', href: 'https://facebook.com/spikonado', src: facebook_logo.src }
	] as const;

	const linkListClass = 'space-y-3';
	const linkClass =
		'font-sans text-base text-foreground transition-colors hover:text-muted-foreground md:text-lg';
	const columnLabelClass =
		'font-sans text-xs font-medium tracking-wide text-muted-foreground uppercase';
</script>

<footer
	class={cn(
		marketingSectionShellClass,
		'border-t border-border/60 px-4 pt-20 pb-10 sm:px-6 sm:pt-24 lg:px-8'
	)}
	data-ph-capture-attribute-section="footer"
>
	<div
		class="relative mx-auto grid w-full max-w-6xl grid-cols-1 gap-12 text-center md:grid-cols-[minmax(0,2fr)_minmax(10rem,1fr)_minmax(10rem,1fr)] md:gap-16 md:text-left"
	>
		<div class="flex flex-col items-center gap-5 md:items-start">
			<a href="/" class="flex items-center gap-3 transition-transform duration-150 hover:scale-105">
				<img loading="lazy" src={logo.src} alt="" class="h-9 w-9" />
				<span class={cn(marketingBrandClass, 'text-2xl sm:text-3xl')}>Spikonado</span>
			</a>
			<p class={cn(marketingSectionBodyClass, 'text-base md:text-lg')}>Build more tech, faster.</p>
		</div>

		<div class="flex flex-col items-center gap-4 md:items-start">
			<h3 class={columnLabelClass}>Products</h3>
			<ul class={linkListClass}>
				{#each productLinks as link (link.label)}
					<li>
						<a href={link.path} class={cn(linkClass, 'font-brand')}>
							{link.label}
						</a>
					</li>
				{/each}
			</ul>
		</div>

		<div class="flex flex-col items-center gap-4 md:items-start">
			<h3 class={columnLabelClass}>Company</h3>
			<ul class={linkListClass}>
				{#each companyLinks as link (link.label)}
					<li>
						<a href={link.path} class={linkClass}>
							{link.label}
						</a>
					</li>
				{/each}
			</ul>
		</div>
	</div>

	<div
		class="relative mx-auto mt-16 flex w-full max-w-6xl flex-col items-center justify-between gap-6 border-t border-border/50 pt-8 text-sm text-muted-foreground md:flex-row"
	>
		<p class="font-sans">&copy; {new Date().getFullYear()} Spikonado</p>
		<div class="flex items-center gap-6">
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			{#each socialLinks as link (link.label)}
				<a
					href={link.href}
					target="_blank"
					rel="noopener noreferrer"
					class="transition-transform duration-150 hover:scale-105"
				>
					<img loading="lazy" src={link.src} alt={link.label} class="h-7 w-7" />
				</a>
			{/each}
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</div>
	</div>
</footer>
