// Shared surface styling for full-width marketing sections and the footer shell.
export const marketingSectionShellClass = 'relative overflow-hidden bg-background';

const marketingHeadingBaseClass =
	'font-brand text-5xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl md:text-7xl';

// Large brand/display heading used for the homepage hero and section titles.
export const marketingSectionHeadingClass = marketingHeadingBaseClass;

// Product titles share the brand typeface at the same scale.
export const marketingProductHeadingClass = marketingHeadingBaseClass;

// Shared supporting copy style for the homepage and footer.
export const marketingSectionBodyClass =
	'max-w-2xl text-lg leading-relaxed text-muted-foreground md:text-xl';

// Brand wordmark used in the navbar and footer.
export const marketingBrandClass = 'font-brand font-semibold tracking-tight text-foreground';

// Elevated copyable command used on page backgrounds (not nested in a panel).
export const marketingCopyCommandSurfaceClass =
	'border-foreground/12 bg-surface shadow-[0_10px_28px_-16px_oklch(0.2_0.02_260/0.55)]';

// Primary solid CTA.
export const marketingButtonPrimaryClass =
	'inline-flex items-center justify-center rounded-full bg-foreground px-5 py-2.5 font-sans text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

// Secondary CTA — soft blue-green fill for download and other paired actions.
export const marketingButtonSecondaryClass =
	'inline-flex items-center justify-center gap-2 rounded-full border border-accent/20 bg-action-soft px-5 py-2.5 font-sans text-sm font-medium text-foreground transition-colors hover:bg-action-soft-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

// Underlined text link used like PostHog secondary CTAs.
export const marketingTextLinkClass =
	'font-sans font-medium text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors hover:decoration-foreground';
