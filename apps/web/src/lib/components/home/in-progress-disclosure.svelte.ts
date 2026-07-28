export function createInProgressDisclosure(getInProgress: () => boolean) {
	let manuallyExpanded = $state(false);
	let manuallyCollapsed = $state(false);

	$effect(() => {
		if (getInProgress()) {
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
