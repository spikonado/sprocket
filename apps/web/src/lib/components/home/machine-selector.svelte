<script lang="ts">
	import { Monitor } from '@lucide/svelte';
	import { hostedMachineOptionLabel, type HostedMachineOption } from '$lib/home/hosted-machines';

	type Props = {
		options: HostedMachineOption[];
		selectedMachineId: string | null;
		onSelect: (machineId: string | null) => void;
		notice?: string | null;
		offerFolderPicker?: boolean;
		onChooseFolder?: () => void;
	};

	let {
		options,
		selectedMachineId,
		onSelect,
		notice = null,
		offerFolderPicker = false,
		onChooseFolder
	}: Props = $props();

	const selectValue = $derived(selectedMachineId ?? '');
	const hasMachines = $derived(options.length > 0);

	function handleChange(event: Event) {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) {
			return;
		}
		onSelect(target.value === '' ? null : target.value);
	}
</script>

<div class="w-full min-w-0">
	<label class="flex w-full min-w-0 items-center gap-2">
		<Monitor class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
		<span class="sr-only">Machine</span>
		<select
			class="border-border bg-background text-foreground h-11 w-full min-w-0 rounded-xl border px-3 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60 sm:h-9 sm:text-sm"
			aria-label="Select machine"
			aria-describedby={notice ? 'hosted-machine-notice' : undefined}
			value={selectValue}
			onchange={handleChange}
		>
			<option value="">Choose a machine</option>
			{#if hasMachines}
				{#each options as option (option.id)}
					<option
						value={option.id}
						disabled={!option.selectable && option.id !== selectedMachineId}
					>
						{hostedMachineOptionLabel(option)}
					</option>
				{/each}
			{/if}
		</select>
	</label>
	{#if notice}
		<p
			id="hosted-machine-notice"
			class="text-muted-foreground mt-2 text-[12.5px] leading-5"
			role="status"
		>
			{notice}
			{#if offerFolderPicker && onChooseFolder}
				<button
					type="button"
					class="text-foreground ml-1 inline-flex min-h-11 items-center rounded-md px-2 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:min-h-8"
					onclick={onChooseFolder}
				>
					Choose folder
				</button>
			{/if}
		</p>
	{/if}
</div>
