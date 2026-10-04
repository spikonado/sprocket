import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguagesInfo } from 'shiki/langs';

let highlighter: ReturnType<typeof createHighlighterCore> | undefined;

export async function highlightCode(code: string, language: string) {
	const name = language.toLowerCase();

	const info = bundledLanguagesInfo.find(
		(entry) => entry.id === name || entry.aliases?.includes(name)
	);

	if (!info) return null;

	highlighter ??= createHighlighterCore({
		engine: createJavaScriptRegexEngine(),
		langs: [],
		themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')]
	});
	const instance = await highlighter;
	await instance.loadLanguage(info.import);

	return instance.codeToTokens(code, {
		lang: info.id,
		themes: { light: 'github-light', dark: 'github-dark' },
		defaultColor: false
	}).tokens;
}
