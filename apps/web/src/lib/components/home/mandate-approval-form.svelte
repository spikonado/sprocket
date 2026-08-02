<script lang="ts">
	import type { MandateApproval } from '$lib/chat/mandate';

	type Props = {
		approval: MandateApproval;
	};

	let { approval }: Props = $props();
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- external Prava approval URL, not an app route -->
<div class="max-w-md">
	<p class="text-foreground text-sm">
		Approve spending{approval.label ? ` · ${approval.label}` : ''}
	</p>
	<p class="text-muted-foreground mt-0.5 text-xs leading-5">
		Opens Prava in a new tab so you can confirm with your passkey.
	</p>
	<a
		href={approval.approvalUrl}
		target="_blank"
		rel="noopener noreferrer"
		class="border-border bg-surface/80 text-foreground hover:bg-hover-fill mt-3 inline-flex h-9 items-center rounded-full border px-4 text-xs font-medium transition"
	>
		Approve mandate
	</a>
</div>
