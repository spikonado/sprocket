import convexPlugin from '@convex-dev/eslint-plugin';
import { config } from '@sprocket/eslint-config/index.js';

export default [
	...config,
	{ ignores: ['convex/_generated/**'] },
	...convexPlugin.configs.recommended,
	{
		files: ['convex/**/*.ts'],
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname
			}
		}
	}
];
