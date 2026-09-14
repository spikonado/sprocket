import { untrack } from 'svelte';

export function createInProgressDisclosure(getInProgress: () => boolean) {
	let manuallyExpanded = $state(false);
	let manuallyCollapsed = $state(false);
	let previousInProgress = untrack(getInProgress);

	$effect(() => {
		const inProgress = getInProgress();
		if (inProgress === previousInProgress) return;
		previousInProgress = inProgress;
		if (inProgress) {
			manuallyCollapsed = false;
		} else {
			manuallyExpanded = false;
		}
	});

	const expanded = $derived(getInProgress() ? !manuallyCollapsed : manuallyExpanded);

	function toggle() {
		if (getInProgress()) {
			manuallyCollapsed = !manuallyCollapsed;
		} else {
			manuallyExpanded = !manuallyExpanded;
		}
	}

	return {
		get expanded() {
			return expanded;
		},
		toggle
	};
}
