#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as Bun from "bun";

const tsc = spawnSync("tsc", ["--noEmit"], { stdio: "inherit" });
if (tsc.status !== 0) {
    process.exit(tsc.status ?? 1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;

const externals = [
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
];

await Bun.build({
    entrypoints: ["src/main.ts"],
    outdir: ".",
    format: "cjs",
    minify: true,
    sourcemap: false,
    external: externals,
    naming: "main.js",
    banner: `/* Obsidian LanguageTool v${version} */`,
});
