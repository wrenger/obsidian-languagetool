// This desktop-only test harness uses Node APIs and fetch, not Obsidian plugin APIs.
import "./obsidian";
import { sleep } from "bun";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import process from "node:process";
import type { RequestUrlParam } from "obsidian";
import type { LTOptions } from "../settings";

const resources = resolve(import.meta.dir, "../../resources");
const archive = join(resources, "LanguageTool-latest-snapshot.zip");
const extracted = join(resources, "languagetool-integration-server");
const url = "https://internal1.languagetool.org/snapshots/LanguageTool-latest-snapshot.zip";
let server: ChildProcess | undefined;
let serverUrl = "";
let logs = "";
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let lastRequest: URLSearchParams;
let lastResponse: { language: { code: string; detectedLanguage: { code: string } } };

const obsidian = await import("obsidian");
let requestUrlSpy: ReturnType<typeof spyOn<typeof obsidian, "requestUrl">>;

async function requestUrl(request: RequestUrlParam) {
    lastRequest = new URLSearchParams(request.body as string);
    const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body as string,
        signal: AbortSignal.timeout(30000),
    });
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    const json = JSON.parse(text) as typeof lastResponse;
    lastResponse = json;
    return {
        status: response.status,
        text,
        json,
        headers: Object.fromEntries(response.headers),
        arrayBuffer,
    };
}

const { check } = await import("../api");
const { DEFAULT_SETTINGS } = await import("../settings");
const { AnnotatedText } = await import("../annotated");

function prepareServer(): string {
    mkdirSync(resources, { recursive: true });
    const marker = join(extracted, ".complete");
    if (existsSync(marker)) {
        const jar = join(extracted, readFileSync(marker, "utf8"), "languagetool-server.jar");
        if (existsSync(jar)) return jar;
    }
    if (!existsSync(archive)) {
        const partial = `${archive}.${process.pid}.part`;
        try {
            execFileSync(
                "curl",
                ["-fL", "--retry", "2", "--connect-timeout", "20", "--max-time", "600", "-o", partial, url],
                { timeout: 610000 },
            );
            execFileSync("unzip", ["-tq", partial], { timeout: 120000 });
            renameSync(partial, archive);
        } finally {
            rmSync(partial, { force: true });
        }
    }
    const staging = mkdtempSync(join(resources, ".languagetool-extract-"));
    try {
        const listing = execFileSync("unzip", ["-Z", "-1", archive], {
            encoding: "utf8",
            timeout: 30000,
        });
        const jarEntry = listing
            .split("\n")
            .find(entry => /^[^/]+\/languagetool-server\.jar$/.test(entry));
        if (!jarEntry) throw new Error("Server jar not found in LanguageTool archive");
        const root = jarEntry.split("/")[0];
        execFileSync("unzip", ["-qo", archive, "-d", staging], { timeout: 180000 });
        if (!existsSync(join(staging, jarEntry)) || !existsSync(join(staging, root, "libs"))) {
            throw new Error("Incomplete LanguageTool extraction");
        }
        writeFileSync(join(staging, ".complete"), root);
        rmSync(extracted, { recursive: true, force: true });
        renameSync(staging, extracted);
        return join(extracted, jarEntry);
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

async function freePort(): Promise<number> {
    const listener = createServer();
    await new Promise<void>((resolve, reject) =>
        listener.once("error", reject).listen(0, "127.0.0.1", resolve),
    );
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate a port");
    await new Promise<void>((resolve, reject) =>
        listener.close(error => (error ? reject(error) : resolve())),
    );
    return address.port;
}

async function stopServer() {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const child = server;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        exited,
        new Promise<void>(resolve => {
            timer = setTimeout(resolve, 5000);
        }),
    ]);
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    }
}

beforeAll(async () => {
    requestUrlSpy = spyOn(obsidian, "requestUrl").mockImplementation(request =>
        requestUrl(typeof request === "string" ? { url: request } : request) as ReturnType<typeof obsidian.requestUrl>,
    );
    Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
    const jar = prepareServer();
    const port = await freePort();
    serverUrl = `http://127.0.0.1:${port}`;
    server = spawn(
        "java",
        ["-cp", jar, "org.languagetool.server.HTTPServer", "--port", String(port)],
        { stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stdout?.on("data", (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-50000);
    });
    server.stderr?.on("data", (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-50000);
    });
    server.on("error", error => {
        logs += `\n${error}`;
    });
    try {
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            if (server.exitCode !== null || server.signalCode !== null) {
                throw new Error("Server exited during startup");
            }
            try {
                const response = await fetch(`${serverUrl}/v2/languages`, {
                    signal: AbortSignal.timeout(1000),
                });
                if (response.ok) return;
            } catch {
                // Server is still starting.
            }
            await sleep(250);
        }
        throw new Error("Timed out waiting for LanguageTool");
    } catch (error) {
        await stopServer();
        throw new Error(`${String(error)}\nLanguageTool logs:\n${logs}`);
    }
}, 900000);

afterAll(async () => {
    await stopServer();
    requestUrlSpy?.mockRestore();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

async function runCheck(text: string, overrides: Partial<LTOptions> = {}) {
    const options = { ...DEFAULT_SETTINGS, serverUrl, preferredLanguages: [], ...overrides };
    try {
        return await check(options, null, 0, new AnnotatedText([{ text }]));
    } catch (error) {
        throw new Error(`${String(error)}\nLanguageTool logs:\n${logs}`, { cause: error });
    }
}

function integrationTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
        try {
            await fn();
        } catch (error) {
            throw new Error(`${String(error)}\nLanguageTool logs:\n${logs}`, { cause: error });
        }
    }, 60000);
}

describe("real LanguageTool /v2/check", () => {
    integrationTest("raw preferredLanguages affects detection when forced", async () => {
        const detect = async (text: string, key: string, force: boolean) => {
            const body = new URLSearchParams({
                text,
                language: "auto",
                preferredVariants: "en-US,de-DE",
                [key]: "de,fr",
                forcePreferredLanguages: String(force),
            });
            const response = await fetch(`${serverUrl}/v2/check`, {
                method: "POST",
                body,
                signal: AbortSignal.timeout(30000),
            });
            if (!response.ok) {
                throw new Error(`Raw check failed: ${response.status} ${await response.text()}`);
            }
            return (await response.json() as typeof lastResponse).language.code;
        };
        const english = "This is a simple sentence that should be clearly recognized as English.";
        expect(await detect(english, "preferredLanguages", false)).toStartWith("en");
        expect(await detect(english, "preferredLanguages", true)).toStartWith("de");
        expect(await detect(english, "preferredLangs", true)).toStartWith("en");
        expect(await detect("Bonjour", "preferredLanguages", true)).toStartWith("fr");
        expect(await detect("Bonjour", "preferredLangs", true)).toBe("br-FR");
    });

    integrationTest("empty preferences preserve English auto detection and return matches", async () => {
        const matches = await runCheck("This is a simple English sentence with a obvious mistake.");
        expect(lastRequest.get("language")).toBe("auto");
        expect(lastRequest.has("preferredLanguages")).toBe(false);
        expect(lastResponse.language.code).toStartWith("en");
        expect(matches.length).toBeGreaterThan(0);
    });

    integrationTest("multiple preferences are sent for auto detection, without restricting clear text", async () => {
        await runCheck("This is a simple sentence that should be clearly recognized as English.", {
            preferredLanguages: ["de", "fr"],
        });
        const englishRequest = lastRequest.get("preferredLanguages");
        expect(lastResponse.language.code).toStartWith("en");
        await runCheck("Das ist ein einfacher deutscher Satz.", {
            preferredLanguages: ["de", "fr"],
        });
        expect(lastResponse.language.code).toStartWith("de");
        expect(englishRequest).toBe("de,fr");
        expect(lastRequest.get("preferredLanguages")).toBe("de,fr");
    });

    integrationTest("static language does not send preferences", async () => {
        await runCheck("This is a simple English sentence.", {
            staticLanguage: "en-US",
            preferredLanguages: ["de", "fr"],
        });
        expect(lastRequest.get("language")).toBe("en-US");
        expect(lastRequest.has("preferredLanguages")).toBe(false);
        expect(lastResponse.language.code).toBe("en-US");
    });
});
