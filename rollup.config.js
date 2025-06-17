import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import webWorker from "rollup-plugin-web-worker-loader";
import typescript2 from "rollup-plugin-typescript2";
import builtins from "builtin-modules";
import terser from "@rollup/plugin-terser";

import fs from "fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = pkg.version;

/**
 * @type {import("rollup").RollupOptions}
 */
export default {
    input: "src/main.ts",
    treeshake: true,
    external: [
        "obsidian",
        "electron",
        "@codemirror/autocomplete",
        "@codemirror/collab",
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/lint",
        "@codemirror/search",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/common",
        "@lezer/highlight",
        "@lezer/lr",
        ...builtins,
    ],
    watch: {
        include: ['src/**'],
        exclude: ['node_modules/**']
    },
    output: {
        dir: ".",
        sourcemap: "inline",
        sourcemapExcludeSources: true,
        format: "cjs",
        exports: "default",
        name: "Obsidian LanguageTool",
        banner: `/* Obsidian LanguageTool v${version} */`,
    },
    plugins: [
        typescript2(),
        nodeResolve({ browser: true }),
        commonjs(),
        webWorker({ inline: true, forceInline: true, targetPlatform: "browser" }),
        terser(),
    ],
};
