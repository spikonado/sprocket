import { highlightCode } from './code-highlighting';
import type { HighlightRequest, HighlightResponse } from './code-highlighting-client';

self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
	const { id, code, language } = event.data;
	const tokens = await highlightCode(code, language).catch(() => null);
	const response: HighlightResponse = { id, tokens };
	self.postMessage(response);
};
