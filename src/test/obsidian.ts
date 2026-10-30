import { mock } from "bun:test";
import type { App, PluginManifest, RequestUrlParam, RequestUrlResponse } from "obsidian";

export const pluginStorage = {
    async saveData(_data: unknown): Promise<void> {
        throw new Error("Unexpected storage write in test");
    },
    async loadData(): Promise<unknown> {
        throw new Error("Unexpected storage read in test");
    },
};

// Keep module identity shared across suites; customize behavior with scoped spies.
mock.module("obsidian", () => ({
    Plugin: class {
        constructor(public app: App, public manifest: PluginManifest) {}
        async saveData(data: unknown): Promise<void> {
            await pluginStorage.saveData(data);
        }
        async loadData(): Promise<unknown> {
            return pluginStorage.loadData();
        }
    },
    PluginSettingTab: class {
        constructor(public app: App, public plugin: unknown) {}
        update() {}
        refreshDomState() {}
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
    requestUrl(_request: RequestUrlParam): Promise<RequestUrlResponse> {
        throw new Error("Unexpected network request in test");
    },
}));
