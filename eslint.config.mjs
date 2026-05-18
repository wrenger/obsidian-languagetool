import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
    {
        languageOptions: {
            globals: { ...globals.browser },
            parserOptions: {
                projectService: { allowDefaultProject: ["eslint.config.js", "manifest.json"] },
                tsconfigRootDir: import.meta.dirname,
                extraFileExtensions: [".json"],
            },
        },
    },
    ...obsidianmd.configs.recommended,
    globalIgnores([
        "node_modules",
        "dist",
        "eslint.config.mjs",
        "versions.json",
        "package.json",
        "main.js",
        "src/test",
        "scripts",
    ]),
);
