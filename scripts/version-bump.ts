#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
    console.error("npm_package_version environment variable not set");
    process.exit(1);
}

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as {
    version: string;
    minAppVersion: string;
    [key: string]: unknown;
};
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from manifest.json
const versions = JSON.parse(readFileSync("versions.json", "utf8")) as Record<string, string>;
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
