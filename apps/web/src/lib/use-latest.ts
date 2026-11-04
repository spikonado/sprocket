import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Holds `value` from the latest commit, so async work never reads an abandoned render. */
export function useLatest<T>(value: T): RefObject<T> {
	const ref = useRef(value);

	useLayoutEffect(() => {
		ref.current = value;
	}, [value]);

	return ref;
}
