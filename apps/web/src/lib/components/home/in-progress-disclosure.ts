import { useCallback, useEffect, useRef, useState } from 'react';

export function useInProgressDisclosure(inProgress: boolean) {
	const [manuallyExpanded, setManuallyExpanded] = useState(false);
	const [manuallyCollapsed, setManuallyCollapsed] = useState(false);
	const previousInProgress = useRef(inProgress);

	useEffect(() => {
		if (inProgress === previousInProgress.current) return;
		previousInProgress.current = inProgress;
		if (inProgress) {
			setManuallyCollapsed(false);
		} else {
			setManuallyExpanded(false);
		}
	}, [inProgress]);

	const expanded = inProgress ? !manuallyCollapsed : manuallyExpanded;

	const toggle = useCallback(() => {
		if (inProgress) {
			setManuallyCollapsed((value) => !value);
		} else {
			setManuallyExpanded((value) => !value);
		}
	}, [inProgress]);

	return { expanded, toggle };
}
