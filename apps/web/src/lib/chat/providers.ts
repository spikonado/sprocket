import type { CompletionProvider } from '@convex/lib/validators';

export const completionProviderLabels: Record<CompletionProvider, string> = {
	spikonado: 'Spikonado',
	openai: 'OpenAI API',
	chatgpt: 'ChatGPT Subscription',
	claude: 'Claude Subscription',
	anthropic: 'Anthropic API',
	vercel: 'Vercel AI Gateway',
	openrouter: 'OpenRouter',
	opencode: 'OpenCode',
	'opencode-go': 'OpenCode Go',
	muse: 'Muse Code Subscription',
	morph: 'Morph'
};
