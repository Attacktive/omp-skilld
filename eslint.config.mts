import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/*
 * Also what Codacy runs: it prefers a repository's own ESLint configuration over its default pattern set, which bundles framework-specific rules this plain TypeScript project has no use for.
 */
export default tseslint.config(
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		rules: {
			complexity: ['warn', 8],
			curly: 'warn',
			'no-undef-init': 'warn'
		}
	}
);
