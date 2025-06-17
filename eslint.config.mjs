import globals from "globals";
import tseslint from "typescript-eslint";

/** @type {import('eslint').Linter.Config[]} */
export default [
    { files: ["/src/**/*.ts"] },
    {
        languageOptions: {
            globals: globals.node,
            ...globals.jest,
        }
    },
    ...tseslint.configs.recommended,
    {
        rules: {
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
            "@typescript-eslint/ban-ts-comment": "off",
            "no-prototype-builtins": "off",
            "@typescript-eslint/no-empty-function": "off",
        },
    },
];
