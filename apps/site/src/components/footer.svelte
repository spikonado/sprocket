<script lang="ts">
	import logo from '@/assets/logo.svg';
	import github_logo from '@/assets/github_logo.svg';
	import x_logo from '@/assets/x_logo.svg';
	import youtube_logo from '@/assets/youtube_logo.svg';
	import instagram_logo from '@/assets/instagram_logo.svg';
	import facebook_logo from '@/assets/facebook_logo.svg';
	import { ORGANIZATION_NAME, ORGANIZATION_URL } from '@/lib/seo';
	import { SPROCKET_GITHUB_URL } from '@/lib/sprocket-releases';
	import { cn } from '@/utils';
	import {
		marketingBrandClass,
		marketingSectionBodyClass,
		marketingSectionShellClass
	} from '@/styles/marketing';

	const sprocketLinks = [
		{ label: 'Home', href: '/' },
		{ label: 'Pricing', href: '/pricing' },
		{ label: 'Download', href: '/#download' },
		{ label: 'GitHub', href: SPROCKET_GITHUB_URL }
	] as const;

	const companyLinks = [
		{ label: ORGANIZATION_NAME, href: ORGANIZATION_URL },
		{ label: 'Build log', href: `${ORGANIZATION_URL}/#build-log` },
		{ label: 'Privacy Policy', href: `${ORGANIZATION_URL}/privacy` }
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
		'border-border/60 border-t px-4 pt-20 pb-10 sm:px-6 sm:pt-24 lg:px-8'
	)}
	data-ph-capture-attribute-section="footer"
>
	<div
		class="relative mx-auto grid w-full max-w-6xl grid-cols-1 gap-12 text-center md:grid-cols-[minmax(0,2fr)_minmax(10rem,1fr)_minmax(10rem,1fr)] md:gap-16 md:text-left"
	>
		<div class="flex flex-col items-center gap-5 md:items-start">
			<a href="/" class="flex items-center gap-3 transition-transform duration-150 hover:scale-105">
				<img loading="lazy" src={logo.src} alt="" class="h-9 w-9" />
				<span class={cn(marketingBrandClass, 'text-2xl sm:text-3xl')}>Sprocket</span>
			</a>
			<p class={cn(marketingSectionBodyClass, 'text-base md:text-lg')}>Build more tech, faster.</p>
		</div>

		<div class="flex flex-col items-center gap-4 md:items-start">
			<h3 class={columnLabelClass}>Sprocket</h3>
			<ul class={linkListClass}>
				{#each sprocketLinks as link (link.label)}
					<li>
						<a href={link.href} class={linkClass}>
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
						<a href={link.href} class={linkClass}>
							{link.label}
						</a>
					</li>
				{/each}
			</ul>
		</div>
	</div>

	<div
		class="border-border/50 text-muted-foreground relative mx-auto mt-16 flex w-full max-w-6xl flex-col items-center justify-between gap-6 border-t pt-8 text-sm md:flex-row"
	>
		<p class="font-sans">&copy; {new Date().getFullYear()} Spikonado</p>
		<div class="flex items-center gap-6">
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
		</div>
	</div>
</footer>
