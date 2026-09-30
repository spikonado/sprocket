import { useCallback, useEffect, useRef, useState } from 'react';

export type LockTooltipState = {
	top: number;
	left: number;
	label: string;
};

export type LockTooltipController = {
	lockTooltip: LockTooltipState | null;
	showLockTooltip: (
		event: { currentTarget: EventTarget | null },
		label: string,
		sticky?: boolean
	) => void;
	hideLockTooltip: (force?: boolean) => void;
};

export function useLockTooltip(): LockTooltipController {
	const [lockTooltip, setLockTooltip] = useState<LockTooltipState | null>(null);
	const stickyRef = useRef(false);
	const stickyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearStickyTimer = useCallback(() => {
		if (stickyTimerRef.current === null) return;
		clearTimeout(stickyTimerRef.current);
		stickyTimerRef.current = null;
	}, []);

	const showLockTooltip = useCallback<LockTooltipController['showLockTooltip']>(
		(event, label, sticky = false) => {
			const target = event.currentTarget;
			if (!(target instanceof HTMLElement)) return;
			const rect = target.getBoundingClientRect();
			clearStickyTimer();
			stickyRef.current = sticky;
			setLockTooltip({
				top: rect.top - 8,
				left: rect.left + rect.width / 2,
				label
			});
			if (sticky) {
				stickyTimerRef.current = setTimeout(() => {
					stickyRef.current = false;
					stickyTimerRef.current = null;
					setLockTooltip(null);
				}, 2500);
			}
		},
		[clearStickyTimer]
	);

	const hideLockTooltip = useCallback(
		(force = false) => {
			if (stickyRef.current && !force) return;
			clearStickyTimer();
			stickyRef.current = false;
			setLockTooltip(null);
		},
		[clearStickyTimer]
	);

	useEffect(() => clearStickyTimer, [clearStickyTimer]);

	return { lockTooltip, showLockTooltip, hideLockTooltip };
}
