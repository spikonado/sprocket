<script lang="ts">
	import type { Id } from '$convex/_generated/dataModel';
	import type { ThreadSummary } from '$lib/types/sprocket';
	import { isActiveThread } from '$lib/workspace/threads';

	type Props = {
		threads: ThreadSummary[];
		onRestore: (threadId: Id<'threadRecords'>) => void;
	};

	let { threads, onRestore }: Props = $props();

	const archivedThreads = $derived(
		[...threads]
			.filter((thread) => !isActiveThread(thread))
			.sort((left, right) => right.lastMessageAt - left.lastMessageAt)
	);
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden">
	<header class="flex h-12 shrink-0 items-center px-6">
		<h1 class="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Archived Threads</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
		<p class="text-muted-foreground mb-6 max-w-xl text-sm leading-6">
			We may permanently delete archived threads from our database at any time.
		</p>
		{#if archivedThreads.length === 0}
			<p class="text-muted-foreground max-w-xl text-sm leading-6">No archived threads.</p>
		{:else}
			<ul class="max-w-xl space-y-1">
				{#each archivedThreads as thread (thread.threadId)}
					<li class="group flex items-center gap-3 py-2">
						<div class="min-w-0 flex-1">
							<p class="text-foreground truncate text-[14px]">{thread.title}</p>
							<p class="text-muted-foreground truncate text-[12px]">{thread.workspaceName}</p>
						</div>
						<button
							type="button"
							class="text-muted-foreground hover:text-muted-foreground shrink-0 px-1 text-[12px] opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
							onclick={() => {
								onRestore(thread.threadId);
							}}
						>
							Restore
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>
