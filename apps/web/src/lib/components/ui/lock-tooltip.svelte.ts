export type LockTooltipState = {
	top: number;
	left: number;
	label: string;
};

export function createLockTooltip() {
	let lockTooltip = $state<LockTooltipState | null>(null);
	let stickyLockTooltip = $state(false);
	let stickyLockTooltipTimer: ReturnType<typeof setTimeout> | null = null;

	function clearStickyLockTooltipTimer() {
		if (!stickyLockTooltipTimer) return;
		clearTimeout(stickyLockTooltipTimer);
		stickyLockTooltipTimer = null;
	}

	function showLockTooltip(event: MouseEvent | FocusEvent, label: string, sticky = false) {
		const target = event.currentTarget;
		if (!(target instanceof HTMLElement)) return;
		const rect = target.getBoundingClientRect();
		clearStickyLockTooltipTimer();
		stickyLockTooltip = sticky;
		lockTooltip = {
			top: rect.top - 8,
			left: rect.left + rect.width / 2,
			label
		};
		if (sticky) {
			stickyLockTooltipTimer = setTimeout(() => {
				stickyLockTooltip = false;
				stickyLockTooltipTimer = null;
				lockTooltip = null;
			}, 2500);
		}
	}

	function hideLockTooltip(force = false) {
		if (stickyLockTooltip && !force) return;
		clearStickyLockTooltipTimer();
		stickyLockTooltip = false;
		lockTooltip = null;
	}

	$effect(() => clearStickyLockTooltipTimer);

	return {
		get lockTooltip() {
			return lockTooltip;
		},
		showLockTooltip,
		hideLockTooltip
	};
}
