import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
	value: true,
	writable: true,
	configurable: true
});

afterEach(cleanup);
