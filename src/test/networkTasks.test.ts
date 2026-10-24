import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { App, PluginManifest, RequestUrlResponse } from "obsidian";
import type { RefreshableTask } from "../refreshableTask";
import type { LTOptions } from "../settings";

let saved: LTOptions | undefined;
let remote: Set<string>;

mock.module("obsidian", () => ({
    Plugin: class {
        constructor(public app: App, public manifest: PluginManifest) {}
        async saveData(data: LTOptions) { saved = structuredClone(data); }
        async loadData() { return structuredClone(saved); }
    },
    PluginSettingTab: class {
        constructor(public app: App, public plugin: unknown) {}
        update() {}
    },
    Modal: class {},
    Notice: class {},
    SecretComponent: class {},
    Setting: class {},
    ButtonComponent: class {},
    MarkdownView: class {},
    Menu: class {},
    setIcon() {},
    setTooltip() {},
    requestUrl() { throw new Error("Unexpected network request in test"); },
}));

const { default: LanguageToolPlugin } = await import("../main");
const api = await import("../api");
const { LTSettingsTab } = await import("../settings");
const { words: requestWords, wordsAdd: addWord, wordsDel: deleteWord } = api;
type TestPlugin = InstanceType<typeof LanguageToolPlugin>;
const plugins: TestPlugin[] = [];
let plugin: TestPlugin;
let originalWindow: PropertyDescriptor | undefined;

function createPlugin() {
    const app = { secretStorage: { getSecret: () => "key" } } as unknown as App;
    const current = new LanguageToolPlugin(app, {} as PluginManifest);
    plugins.push(current);
    return current;
}

function dictionaryTask(current = plugin): RefreshableTask {
    return (current as unknown as { dictionaryTask: RefreshableTask }).dictionaryTask;
}

function mockRemote() {
    spyOn(api, "words").mockImplementation(async () => [...remote]);
    spyOn(api, "wordsAdd").mockImplementation(async (_options, _key, word) => {
        remote.add(word);
        return true;
    });
    spyOn(api, "wordsDel").mockImplementation(async (_options, _key, word) => remote.delete(word));
}

beforeEach(async () => {
    saved = undefined;
    remote = new Set();
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { setTimeout: mock(() => 1), clearTimeout: mock(() => {}) },
    });
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(api, "languages").mockResolvedValue([]);
    mockRemote();
    plugin = createPlugin();
    await plugin.settings.update({ endpoint: "premium", username: "test@example.com" });
    await dictionaryTask().ensure();
});

afterEach(() => {
    for (const current of plugins) {
        const tasks = current as unknown as { languageTask: RefreshableTask; dictionaryTask: RefreshableTask };
        tasks.languageTask.dispose();
        tasks.dictionaryTask.dispose();
    }
    plugins.length = 0;
    mock.restore();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("migrates unsynchronized edits from the remote snapshot", async () => {
    spyOn(plugin, "loadData").mockResolvedValue({
        endpoint: "premium",
        serverUrl: plugin.settings.options.serverUrl,
        username: "test@example.com",
        dictionary: ["keep", "local-new", "remote-deleted"],
        remoteDictionary: ["keep", "local-deleted", "remote-deleted"],
        syncDictionary: true,
    });
    remote = new Set(["keep", "local-deleted", "remote-new"]);
    await plugin.settings.load();
    expect(saved).not.toHaveProperty("remoteDictionary");
    await plugin.syncDictionary();
    expect([...remote].sort()).toEqual(["keep", "local-new", "remote-new"]);
    expect(saved!.dictionary).toEqual([...remote].sort());
    expect(saved!.pendingDictEdits).toEqual([]);
});

test("enabling sync merges existing local and remote words", async () => {
    await plugin.settings.update({ dictionary: ["local", "shared"] });
    remote = new Set(["remote", "shared"]);

    await plugin.settings.update({ syncDictionary: true });
    await dictionaryTask().ensure();

    expect([...remote].sort()).toEqual(["local", "remote", "shared"]);
    expect(saved!.dictionary).toEqual(["local", "remote", "shared"]);
    expect(saved!.pendingDictEdits).toEqual([]);
});

test("disabling stops remaining in-flight edits and ignores their results", async () => {
    let finish!: () => void;
    let started!: () => void;
    const writing = new Promise<void>(resolve => { finish = resolve; });
    const startedWriting = new Promise<void>(resolve => { started = resolve; });
    spyOn(api, "wordsAdd").mockImplementation(async (_options, _key, word) => {
        started();
        await writing;
        remote.add(word);
        return true;
    });
    await plugin.settings.update({ dictionary: ["first", "second"], syncDictionary: true });
    await startedWriting;
    await plugin.settings.update({ syncDictionary: false });
    finish();
    await dictionaryTask().ensure();

    expect(api.wordsAdd).toHaveBeenCalledTimes(1);
    expect(api.words).not.toHaveBeenCalled();
    expect(saved!.dictionary).toEqual(["first", "second"]);
    expect(saved!.pendingDictEdits).toEqual([]);
});

test("loading disabled sync discards persisted pending edits", async () => {
    spyOn(plugin, "loadData").mockResolvedValue({
        ...plugin.settings.options,
        dictionary: ["local"],
        syncDictionary: false,
        pendingDictEdits: [{ word: "remote", present: false, revision: 1 }],
    });
    await plugin.settings.load();
    expect(saved!.dictionary).toEqual(["local"]);
    expect(saved!.pendingDictEdits).toEqual([]);
});

test("offline edits coalesce, survive restart, and replay when connected", async () => {
    const offline = new api.RequestError("offline", true);
    spyOn(api, "wordsAdd").mockRejectedValue(offline);
    spyOn(api, "wordsDel").mockRejectedValue(offline);
    await plugin.settings.update({ dictionary: ["word"], syncDictionary: true });
    await dictionaryTask().ensure();
    await plugin.settings.update({ dictionary: [] });
    await dictionaryTask().ensure();
    expect(saved!.pendingDictEdits).toEqual([
        expect.objectContaining({ word: "word", present: false }),
    ]);
    await plugin.settings.update({ dictionary: ["added"] });
    await dictionaryTask().ensure();
    dictionaryTask().dispose();

    remote.add("word");
    mockRemote();
    const restarted = createPlugin();
    await restarted.settings.load();
    await restarted.syncDictionary();
    expect([...remote]).toEqual(["added"]);
    expect(saved!.dictionary).toEqual(["added"]);
    expect(saved!.pendingDictEdits).toEqual([]);
});

test("a newer edit survives an in-flight write", async () => {
    await plugin.settings.update({ dictionary: ["word"], syncDictionary: true });
    await dictionaryTask().ensure();
    let finish!: () => void;
    let started!: () => void;
    const writing = new Promise<void>(resolve => { finish = resolve; });
    const startedWriting = new Promise<void>(resolve => { started = resolve; });
    spyOn(api, "wordsDel").mockImplementation(async (_options, _key, word) => {
        started();
        await writing;
        return remote.delete(word);
    });
    await plugin.settings.update({ dictionary: [] });
    await startedWriting;
    await plugin.settings.update({ dictionary: ["word"] });
    finish();
    await dictionaryTask().ensure();
    expect([...remote]).toEqual(["word"]);
    expect(saved!.dictionary).toEqual(["word"]);
    expect(saved!.pendingDictEdits).toEqual([]);
});

test.each([{ username: "other@example.com" }, { endpoint: "public" as const }])(
    "changing connection settings discards pending edits",
    async options => {
        spyOn(api, "wordsAdd").mockRejectedValue(new api.RequestError("offline", true));
        await plugin.settings.update({ dictionary: ["word"], syncDictionary: true });
        await dictionaryTask().ensure();
        expect(saved!.pendingDictEdits).toHaveLength(1);

        await plugin.settings.update(options);
        expect(saved!.pendingDictEdits).toEqual([]);
        expect(saved!.dictionary).toEqual(["word"]);
    },
);

test("explicit synchronization pulls remote additions and removals", async () => {
    await plugin.settings.update({ syncDictionary: true });
    await dictionaryTask().ensure();
    remote.add("remote-new");
    await plugin.syncDictionary();
    expect(saved!.dictionary).toEqual(["remote-new"]);
    remote.clear();
    await plugin.syncDictionary();
    expect(saved!.dictionary).toEqual([]);
});

test("local edits are saved before network writes", async () => {
    let finish!: () => void;
    const saving = new Promise<void>(resolve => { finish = resolve; });
    spyOn(plugin, "saveData").mockImplementationOnce(async data => {
        await saving;
        saved = structuredClone(data);
    });
    const editing = plugin.settings.update({ dictionary: ["word"], syncDictionary: true });
    await Promise.resolve();
    expect(api.wordsAdd).not.toHaveBeenCalled();
    finish();
    await editing;
    await dictionaryTask().ensure();
    expect([...remote]).toEqual(["word"]);
    expect(saved!.pendingDictEdits).toEqual([]);
});

test("updates serialize and reject sync results made obsolete while queued", async () => {
    let finish!: () => void;
    const saving = new Promise<void>(resolve => { finish = resolve; });
    const saves = spyOn(plugin, "saveData").mockImplementation(async data => {
        await saving;
        saved = structuredClone(data);
    });
    const editing = plugin.settings.update({ dictionary: ["word"] });
    const language = plugin.settings.update({ staticLanguage: "de-DE" });
    const syncing = plugin.settings.applyDictionarySync([], [], () =>
        plugin.settings.options.dictionary.length === 0,
    );
    await Promise.resolve();
    expect(saves).toHaveBeenCalledTimes(1);
    expect(plugin.settings.options.dictionary).toEqual([]);
    finish();
    await Promise.all([editing, language, syncing]);
    expect(saves).toHaveBeenCalledTimes(2);
    expect(saved!.dictionary).toEqual(["word"]);
    expect(saved!.staticLanguage).toBe("de-DE");
    expect(saved!.pendingDictEdits).toEqual([]);
});

test.each([
    "dictionary",
    "enabledCategories",
    "disabledCategories",
    "enabledRules",
    "disabledRules",
] as const)("overlapping %s edits use the latest committed list", async key => {
    await plugin.settings.update({ [key]: ["keep", "remove"] });
    let finish!: () => void;
    let started!: () => void;
    const saving = new Promise<void>(resolve => { finish = resolve; });
    const startedSaving = new Promise<void>(resolve => { started = resolve; });
    spyOn(plugin, "saveData").mockImplementationOnce(async data => {
        started();
        await saving;
        saved = structuredClone(data);
    });

    const first = plugin.settings.update(current => ({
        [key]: [...current[key], "first"],
    }));
    await startedSaving;
    const second = plugin.settings.update(current => ({
        [key]: [...current[key], "second"],
    }));
    const removing = plugin.settings.update(current => ({
        [key]: current[key].filter(value => value !== "remove"),
    }));
    expect(plugin.settings.options[key]).toEqual(["keep", "remove"]);
    finish();
    await Promise.all([first, second, removing]);

    expect(saved![key]).toEqual(["keep", "first", "second"]);
    expect(plugin.settings.options[key]).toEqual(saved![key]);

});

test("failed acknowledgment saves retry without losing edits", async () => {
    let fail = true;
    spyOn(plugin, "saveData").mockImplementation(async data => {
        const options = data as LTOptions;
        if (fail && options.dictionary.includes("word") && !options.pendingDictEdits.length) {
            fail = false;
            throw new Error("disk unavailable");
        }
        saved = structuredClone(options);
    });
    await plugin.settings.update({ dictionary: ["word"], syncDictionary: true });
    await dictionaryTask().ensure();
    expect(saved!.pendingDictEdits).toHaveLength(1);
    dictionaryTask().retry();
    await dictionaryTask().ensure();
    expect(saved!.pendingDictEdits).toEqual([]);
    expect(saved!.dictionary).toEqual(["word"]);
});

test.each([addWord, deleteWord])("mutations do not use synthetic timeouts", async mutate => {
    const obsidian = await import("obsidian");
    spyOn(obsidian, "requestUrl").mockReturnValue(Promise.resolve({
        status: 200, json: { added: true, deleted: true },
    } as RequestUrlResponse) as ReturnType<typeof obsidian.requestUrl>);
    expect(await mutate(plugin.settings.options, "key", "word")).toBeTrue();
    expect(window.setTimeout).not.toHaveBeenCalled();
});
