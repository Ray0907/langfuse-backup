import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		ignores: ["dist/**", "coverage/**", "node_modules/**"],
	},
	{
		languageOptions: {
			globals: globals.node,
		},
	},
	{
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/consistent-type-imports": "error",
			"@typescript-eslint/no-explicit-any": "error",
			indent: ["error", "tab", { SwitchCase: 1 }],
			"max-len": ["error", { code: 100, ignoreUrls: true }],
			quotes: ["error", "double", { avoidEscape: true }],
			semi: ["error", "always"],
		},
	},
);
