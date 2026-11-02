const config = {
	ignorePatterns: [
		'.agent/**',
		'.agents/**',
		'.claude/**',
		'.codex/**',
		'.continue/**',
		'.cursor/**',
		'.delta/**',
		'.gemini/**',
		'.opencode/**',
		'.pi/**',
		'.roo/**',
		'.windsurf/**',
		'.worktrees/**',
		'ref-repos/**',
		'target/**',
		'tools/oxlint/anti-slop/**',
		'apps/web/convex/_generated/**',
		'apps/web/static/kicanvas/**'
	],
	plugins: ['typescript', 'unicorn', 'oxc', 'react'],
	categories: { correctness: 'error' },
	jsPlugins: [
		{
			name: 'anti-slop',
			specifier: './tools/oxlint/anti-slop/index.ts'
		},
		'@convex-dev/eslint-plugin'
	],
	rules: {
		'typescript/no-confusing-non-null-assertion': 'error',
		'oxc/no-accumulating-spread': 'error',
		'anti-slop/no-array-filter-map': 'error',
		'anti-slop/no-reduce-accumulator-copy': 'error',
		'anti-slop/no-chained-type-assertions': 'error',
		'anti-slop/no-conditional-empty-object-spread': 'error',
		'anti-slop/no-known-value-widening': 'error',
		'anti-slop/no-module-mocking': 'error',
		'anti-slop/no-object-parameters': 'error',
		'anti-slop/no-reflect-apply': 'error',
		'anti-slop/no-reflect-get': 'error',
		'anti-slop/no-runtime-typeof': 'error',
		'anti-slop/no-shape-in-symbol-names': 'error',
		'anti-slop/no-unknown-parameters': 'error',
		'anti-slop/no-unknown-returns': 'error',
		'anti-slop/no-unknown-type-aliases': 'error',
		'anti-slop/no-unsafe-dictionary-type': 'error',
		'anti-slop/no-widen-then-assert': 'error',
		'anti-slop/require-readable-spacing': 'error',
		'anti-slop/require-safety-comment-for-type-assertion': 'error',
		'no-unmodified-loop-condition': [
			'error',
			{
				checkConditionalExpressions: true
			}
		],
		'no-case-declarations': 'error',
		'no-empty': 'error',
		'no-fallthrough': 'error',
		'no-prototype-builtins': 'error',
		'no-regex-spaces': 'error',
		'no-useless-assignment': 'error',
		'preserve-caught-error': 'error',
		'no-var': 'error',
		'prefer-const': 'error',
		'prefer-rest-params': 'error',
		'prefer-spread': 'error',
		'no-array-constructor': 'error',
		// Empty options drop oxlint's default `^_` ignore patterns, matching ESLint.
		'no-unused-vars': ['error', {}],
		'typescript/ban-ts-comment': 'error',
		'typescript/no-empty-object-type': 'error',
		'typescript/no-explicit-any': 'error',
		'typescript/no-namespace': 'error',
		'typescript/no-require-imports': 'error',
		'typescript/no-unnecessary-type-constraint': 'error',
		'typescript/no-unsafe-function-type': 'error',
		'react/rules-of-hooks': 'error',
		'react/refs': 'off',
		'react/set-state-in-effect': 'off'
	},
	overrides: [
		{ files: ['**/*.cjs'], rules: { 'typescript/no-require-imports': 'off' } },
		{
			files: ['apps/web/convex/**/*.ts'],
			rules: {
				'@convex-dev/no-old-registered-function-syntax': 'error',
				'@convex-dev/require-args-validator': 'error',
				'@convex-dev/explicit-table-ids': 'error',
				'@convex-dev/no-filter-in-query': 'warn',
				'@convex-dev/no-top-of-hour-crons': 'warn',
				'@convex-dev/no-schema-import-cycle': 'error',
				'@convex-dev/no-duplicate-indexes': 'error',
				'@convex-dev/no-process-env': 'error'
			}
		}
	]
};

export default config;
