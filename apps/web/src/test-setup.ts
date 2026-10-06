import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
	value: true,
	writable: true,
	configurable: true
});

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
	value: vi.fn(),
	writable: true,
	configurable: true
});

afterEach(cleanup);

Object.defineProperties(HTMLDialogElement.prototype, {
	showModal: {
		value: function (this: HTMLDialogElement) {
			this.open = true;
		},
		writable: true,
		configurable: true
	},
	close: {
		value: function (this: HTMLDialogElement) {
			this.open = false;
		},
		writable: true,
		configurable: true
	}
});
