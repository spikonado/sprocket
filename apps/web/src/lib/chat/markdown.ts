import DOMPurify from 'isomorphic-dompurify';
import { marked } from 'marked';

marked.setOptions({
	gfm: true,
	breaks: true
});

export function renderMarkdown(value: string) {
	const rendered = marked.parse(value, {
		async: false
	});

	return DOMPurify.sanitize(rendered, {
		ADD_ATTR: ['target', 'rel']
	});
}
