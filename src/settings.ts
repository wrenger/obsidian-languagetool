import {
    App,
    Modal,
    Notice,
    PluginSettingTab,
    SecretComponent,
    Setting,
    SettingDefinitionItem,
    SettingDefinitionList,
} from "obsidian";

import LanguageToolPlugin from "./main";
import * as api from "./api";
import { cmpIgnoreCase } from "./helpers";

export const SUGGESTIONS = 8;
const DEFAULT_SECRET_APIKEY = "languagetool-apikey";

/**
 * Unfortunately LanguageTool API does not provide a list of supported mother tongues,
 * so we hardcode the ones from https://languagetool.org/editor/settings/language.
 */
export const MOTHER_TONGUES: Record<string, string> = {
    "": "Disabled",
    ar: "Arabic",
    ca: "Catalan",
    da: "Danish",
    de: "German",
    en: "English",
    es: "Spanish",
    fr: "French",
    gl: "Galician",
    it: "Italian",
    ja: "Japanese",
    nl: "Dutch",
    pl: "Polish",
    pt: "Portuguese",
    ru: "Russian",
    sv: "Swedish",
    uk: "Ukrainian",
    zh: "Chinese",
};

/**
 * Unfortunately LanguageTool API does not provide a list of supported mother language varieties,
 * so we hardcode the ones from https://languagetool.org/editor/settings/language.
 */
interface LanguageVariety {
    code: string;
    name: string;
    variants: Record<string, string>;
}
export const LANGUAGE_VARIETIES: LanguageVariety[] = [
    {
        code: "en",
        name: "English",
        variants: {
            "en-US": "English (US)",
            "en-GB": "English (British)",
            "en-CA": "English (Canada)",
            "en-AU": "English (Australia)",
            "en-ZA": "English (South Africa)",
            "en-NZ": "English (New Zealand)",
        },
    },
    {
        code: "de",
        name: "German",
        variants: {
            "de-DE": "German (Germany)",
            "de-AT": "German (Austria)",
            "de-CH": "German (Switzerland)",
        },
    },
    {
        code: "pt",
        name: "Portuguese",
        variants: {
            "pt-BR": "Portuguese (Brazil)",
            "pt-PT": "Portuguese (Portugal)",
            "pt-AO": "Portuguese (Angola)",
            "pt-MZ": "Portuguese (Mozambique)",
        },
    },
    {
        code: "ca",
        name: "Catalan",
        variants: { "ca-ES": "Catalan", "ca-ES-valencia": "Catalan (Valencian)" },
    },
];

export class Endpoint {
    url: string;
    requestsPerSec: number;
    maxSize: number;

    constructor(url: string, requestsPerSec: number, maxSize: number) {
        this.url = url;
        this.requestsPerSec = requestsPerSec;
        this.maxSize = maxSize;
    }
    /** Return the minimum delay in ms */
    get minDelay() {
        return (60 / this.requestsPerSec) * 1000;
    }
}

/** See https://languagetool.org/http-api/swagger-ui/# */
const endpoints = {
    public: new Endpoint("https://api.languagetool.org", 20, 20000),
    premium: new Endpoint("https://api.languagetoolplus.com", 80, 75000),
    custom: new Endpoint("", 120, 1000000),
};
export type EndpointType = keyof typeof endpoints;

export function endpointFromUrl(url: string): EndpointType {
    for (const [key, value] of Object.entries(endpoints)) {
        if (value.url === url) return key as EndpointType;
    }
    return "custom";
}
export function getEndpoint(url: string): Endpoint {
    return endpoints[endpointFromUrl(url)];
}

/** Edits to the dictionary that could be uploaded to LanguageTool yet */
export interface DictEdit {
    word: string;
    /** add or remove from the dictionary */
    present: boolean;
    revision: number;
}

export type SettingsUpdateSource = "local" | "sync" | "external";

/** Wrapper for LanguageTool settings */
export class LTSettings {
    private _options: LTOptions;
    private tab: LTSettingsTab;
    private updates: Promise<void> = Promise.resolve();
    constructor(tab: LTSettingsTab) {
        this.tab = tab;
        this._options = { ...DEFAULT_SETTINGS };
    }
    public get options(): Readonly<LTOptions> {
        return this._options;
    }
    public update(
        options: Partial<LTOptions> | ((current: Readonly<LTOptions>) => Partial<LTOptions>),
        source: SettingsUpdateSource = "local",
    ): Promise<void> {
        return this.enqueue(() =>
            this.updateOptions(
                typeof options === "function" ? options(this._options) : options,
                source,
            ),
        );
    }

    /**
     * UI callbacks and background sync can overlap while awaiting asynchronous disk I/O.
     * Serialize the whole read-modify-save operation so each update uses the latest
     * committed settings; serializing writes alone would still allow lost updates.
     */
    private enqueue(update: () => Promise<void>): Promise<void> {
        const pending = this.updates.then(update);
        this.updates = pending.catch(() => {});
        return pending;
    }
    private async updateOptions(
        options: Partial<LTOptions>,
        source: SettingsUpdateSource,
    ): Promise<void> {
        let newOptions = { ...options };

        // Merge languageVariety with existing values if provided
        if ("languageVariety" in newOptions) {
            newOptions.languageVariety = {
                ...this._options.languageVariety,
                ...newOptions.languageVariety,
            };
        }

        // React on changes

        if (newOptions.endpoint != null && newOptions.endpoint !== "custom") {
            newOptions.serverUrl = endpoints[newOptions.endpoint].url;
        }

        let updatedOptions = { ...this._options, ...newOptions };
        if (
            updatedOptions.serverUrl !== this._options.serverUrl ||
            updatedOptions.username !== this._options.username
        ) {
            updatedOptions.pendingDictEdits = [];
        }
        if (!updatedOptions.syncDictionary) {
            updatedOptions.pendingDictEdits = [];
        } else if (!this._options.syncDictionary) {
            updatedOptions.pendingDictEdits = [...new Set(updatedOptions.dictionary)].map(
                (word, index) => ({ word, present: true, revision: index + 1 }),
            );
        } else if (source === "local" && newOptions.dictionary) {
            const before = new Set(this._options.dictionary);
            const after = new Set(updatedOptions.dictionary);
            let edits = [...updatedOptions.pendingDictEdits];
            let revision = edits.reduce((latest, edit) => Math.max(latest, edit.revision), 0);
            for (const word of new Set([...before, ...after])) {
                if (before.has(word) === after.has(word)) continue;
                edits = edits.filter(edit => edit.word !== word);
                edits.push({ word, present: after.has(word), revision: ++revision });
            }
            updatedOptions.pendingDictEdits = edits;
        }

        // Only save if something has changed
        if (JSON.stringify(updatedOptions) !== JSON.stringify(this._options)) {
            const previous = this._options;
            await this.save(updatedOptions);
            this._options = updatedOptions;
            if (newOptions.injectProperties != null) {
                this.tab.plugin.injectProperties(newOptions.injectProperties);
            }
            this.tab.plugin.onSettingsChanged(previous, source);
        }
    }

    public applyDictionarySync(
        dictionary: string[],
        acknowledged: DictEdit[],
        isCurrent: () => boolean,
    ): Promise<void> {
        return this.enqueue(async () => {
            // A local update ahead of this result may have invalidated the network run.
            if (!isCurrent()) return;
            const pendingDictEdits = this._options.pendingDictEdits.filter(
                edit =>
                    !acknowledged.some(
                        done => done.word === edit.word && done.revision === edit.revision,
                    ),
            );
            await this.updateOptions({ dictionary, pendingDictEdits: pendingDictEdits }, "sync");
        });
    }

    public load(): Promise<void> {
        return this.enqueue(async () => {
            const options = await this.loadOptions();
            this._options = { ...DEFAULT_SETTINGS, ...options };
        });
    }

    public getApiKey(): string | null {
        return this.tab.app.secretStorage.getSecret(this.options.apikeySecret);
    }

    protected async loadOptions(): Promise<Partial<LTOptions>> {
        let data = ((await this.tab.plugin.loadData()) ?? {}) as Record<string, unknown>;

        let snapshot = JSON.stringify(data);

        // Migration: endpoint
        if (!("endpoint" in data)) {
            // Determine endpoint based on serverUrl
            const endpoint =
                typeof data.serverUrl === "string"
                    ? endpointFromUrl(data.serverUrl)
                    : DEFAULT_SETTINGS.endpoint;
            data = { ...data, endpoint: endpoint };
        }

        // Migration: categories and rules
        let parseList = (data: Record<string, unknown>, key: string) => {
            if (typeof data[key] === "string" && data[key])
                data = { ...data, [key]: data[key].split(",") };

            let value = data[key];
            if (Array.isArray(value)) data[key] = value.filter(Boolean);
            else data[key] = [];
            return data;
        };
        data = parseList(data, "enabledCategories");
        data = parseList(data, "disabledCategories");
        data = parseList(data, "enabledRules");
        data = parseList(data, "disabledRules");

        // Migration: api key into secret storage
        if ("apikey" in data && typeof data.apikey === "string") {
            this.tab.app.secretStorage.setSecret(DEFAULT_SECRET_APIKEY, data.apikey);
            data.apikeySecret = DEFAULT_SECRET_APIKEY;
            delete data.apikey;
        }
        if (!data.apikeySecret) data.apikeySecret = "";

        // Migration: preserve unsynchronized edits before removing the remote snapshot.
        if (!("pendingDictEdits" in data)) {
            if (data.endpoint === "premium" && data.syncDictionary) {
                const local = new Set(
                    Array.isArray(data.dictionary) ? (data.dictionary as string[]) : [],
                );
                const remote = new Set(
                    Array.isArray(data.remoteDictionary) ? (data.remoteDictionary as string[]) : [],
                );
                const edits: DictEdit[] = [];
                for (const word of new Set([...local, ...remote])) {
                    if (local.has(word) !== remote.has(word)) {
                        edits.push({ word, present: local.has(word), revision: edits.length + 1 });
                    }
                }
                data.pendingDictEdits = edits;
            } else {
                data.pendingDictEdits = [];
            }
        }
        if (!data.syncDictionary) data.pendingDictEdits = [];
        delete data.remoteDictionary;

        // Save if options were migrated
        if (snapshot !== JSON.stringify(data)) {
            await this.tab.plugin.saveData({ ...DEFAULT_SETTINGS, ...data });
        }

        return data;
    }

    protected async save(options: LTOptions): Promise<void> {
        console.debug("saving language tool settings");
        try {
            await this.tab.plugin.saveData(options);
        } catch (error) {
            throw new api.RequestError(
                "Saving dictionary edits failed; synchronization will retry.",
                true,
                { cause: error },
            );
        }
    }
}

export interface LTOptions {
    endpoint: EndpointType;
    serverUrl: string;
    apikeySecret: string;
    username?: string;

    shouldAutoCheck: boolean;
    autoCheckDelay: number;
    synonyms: string;

    motherTongue: string;
    staticLanguage: string;
    languageVariety: Record<string, string>;

    dictionary: string[];
    syncDictionary: boolean;

    pendingDictEdits: DictEdit[];

    pickyMode: boolean;
    enabledCategories: string[];
    disabledCategories: string[];
    enabledRules: string[];
    disabledRules: string[];

    longCheckNotification: boolean;
    injectProperties: boolean;
}

export const DEFAULT_SETTINGS: LTOptions = {
    endpoint: "public",
    serverUrl: endpoints["public"].url,
    apikeySecret: "",
    autoCheckDelay: endpoints.public.minDelay,
    shouldAutoCheck: false,
    synonyms: "",
    motherTongue: "",
    staticLanguage: "",
    languageVariety: Object.fromEntries(
        LANGUAGE_VARIETIES.map(v => [v.code, Object.keys(v.variants)[0]]),
    ),
    dictionary: [],
    syncDictionary: false,
    pendingDictEdits: [],
    pickyMode: false,
    enabledCategories: [],
    disabledCategories: [],
    enabledRules: [],
    disabledRules: [],
    longCheckNotification: true,
    injectProperties: true,
};

class InputModal extends Modal {
    constructor(
        app: App,
        title: string,
        onSubmit: (result: string) => void,
        validate?: (result: string) => string | void,
    ) {
        super(app);
        this.setTitle(title);

        let value = "";
        const input = new Setting(this.contentEl).setName("New");
        const submit = new Setting(this.contentEl).addButton(btn => {
            btn.setButtonText("Submit")
                .setCta()
                .setDisabled(true)
                .onClick(() => {
                    this.close();
                    onSubmit(value);
                });
        });
        input.addText(text =>
            text.onChange(v => {
                value = v.trim();
                if (validate) {
                    const error = validate(v) ?? null;
                    input.setErrorMessage(error);
                    submit.setDisabled(!value || !!error);
                } else {
                    submit.setDisabled(!value);
                }
            }),
        );
    }
}

export class LTSettingsTab extends PluginSettingTab {
    readonly plugin: LanguageToolPlugin;
    private languages: api.Language[] = [];

    public constructor(app: App, plugin: LanguageToolPlugin) {
        super(app, plugin);
        this.icon = "spell-check";
        this.plugin = plugin;
    }

    setLanguages(languages: api.Language[]): void {
        this.languages = languages;
        this.update();
    }

    getControlValue(key: string): unknown {
        if (key.startsWith("languageVariety.")) {
            const lang = key.split(".")[1];
            return this.plugin.settings.options.languageVariety?.[lang];
        }
        if (key in this.plugin.settings.options) {
            return (this.plugin.settings.options as Readonly<Record<string, unknown>>)[key];
        }
        return undefined;
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        if (key.startsWith("languageVariety.")) {
            const lang = key.split(".")[1];
            await this.plugin.settings.update({
                languageVariety: {
                    [lang]: value as string,
                },
            });
        } else {
            await this.plugin.settings.update({ [key]: value });
        }
        this.refreshDomState();
    }

    public getSettingDefinitions(): SettingDefinitionItem[] {
        console.debug("getSettingDefinitions");
        this.plugin.ensureNetworkTasks();

        const sortedStrList = (
            name: string,
            key:
                | "dictionary"
                | "enabledCategories"
                | "disabledCategories"
                | "enabledRules"
                | "disabledRules",
            validate?: (v: string) => string | void,
            onUpdate?: () => void,
        ): SettingDefinitionList => {
            const values = this.plugin.settings.options[key];
            if (!Array.isArray(values)) throw new Error(`Expected ${key} to be an array`);

            return {
                type: "list",
                heading: name,
                items: values.map(v => ({ name: v, searchable: false })),
                emptyState: "No items",
                addItem: {
                    name: "Add item",
                    action: () => {
                        const modal = new InputModal(
                            this.app,
                            "Add item",
                            v => {
                                this.plugin.settings
                                    .update(current => ({
                                        [key]: [...new Set([...current[key], v])].sort(
                                            cmpIgnoreCase,
                                        ),
                                    }))
                                    .then(
                                        () => {
                                            this.update();
                                            onUpdate?.();
                                        },
                                        e => console.error("Failed to update settings", e),
                                    );
                            },
                            validate,
                        );
                        modal.open();
                    },
                },
                onDelete: index => {
                    const removed = values[index];
                    this.plugin.settings
                        .update(current => ({
                            [key]: current[key].filter(value => value !== removed),
                        }))
                        .then(
                            () => {
                                this.update();
                                onUpdate?.();
                            },
                            e => console.error("Failed to update settings", e),
                        );
                },
            };
        };

        const settings = this.plugin.settings;
        return [
            {
                name: "Endpoint",
                control: {
                    type: "dropdown",
                    key: "endpoint",
                    options: Object.fromEntries(
                        Object.entries(endpoints).map(([key, value]) => [
                            key,
                            `(${key}) ${value.url.replace(/^https?:\/\//, "")}`,
                        ]),
                    ),
                    defaultValue: "public",
                },
            },
            {
                name: "Server URL",
                control: {
                    type: "text",
                    key: "serverUrl",
                    placeholder: "http://your-custom-url.com",
                    validate: async (value: string) => {
                        console.debug("check server url");
                        if (settings.options.endpoint !== "custom") return;
                        try {
                            let languages = await api.languages(value);
                            console.debug("Languages", languages);
                            return undefined;
                        } catch (e) {
                            let message = "";
                            if (e instanceof Error) message = e.message;
                            return "Cannot connect to server" + (message ? `: ${message}` : "");
                        }
                    },
                },
                visible: () => settings.options.endpoint === "custom",
            },
            {
                name: "API username",
                control: {
                    type: "text",
                    key: "username",
                    placeholder: "peterlustig@example.com",
                    validate: (value: string) => {
                        if (settings.options.endpoint === "premium" && !value)
                            return "Username is required for premium endpoint";
                    },
                },
                visible: () => settings.options.endpoint !== "public",
            },
            {
                name: "API key",
                render: (setting, group) => {
                    setting.addComponent(el =>
                        new SecretComponent(this.app, el)
                            .setValue(settings.options.apikeySecret)
                            .onChange(async value => {
                                await settings.update({ apikeySecret: value });
                                this.plugin.ensureNetworkTasks();
                            }),
                    );
                },
                visible: () => settings.options.endpoint !== "public",
            },
            { name: "Auto check text", control: { type: "toggle", key: "shouldAutoCheck" } },
            {
                name: "Auto check delay",
                control: {
                    type: "slider",
                    key: "autoCheckDelay",
                    min: 500,
                    max: 5000,
                    step: 250,
                    disabled: () => !settings.options.shouldAutoCheck,
                },
            },
            {
                name: "Find synonyms",
                desc: createFragment(frag => {
                    frag.createEl("a", {
                        text: "Click here for information about premium access",
                        href: "https://github.com/wrenger/obsidian-languagetool#premium-accounts",
                        attr: { target: "_blank" },
                    });
                }),
                control: {
                    type: "dropdown",
                    key: "synonyms",
                    options: Object.fromEntries([
                        ["", "Disabled"],
                        ...Object.entries(api.SYNONYMS).map(([k, v]) => [k, v?.name]),
                    ]) as Record<string, string>,
                },
            },
            {
                type: "group",
                heading: "Language",
                items: [
                    {
                        name: "Static language",
                        desc: createFragment(frag => {
                            frag.appendText("The language to use for spell checking.");
                            frag.createEl("br");
                            frag.appendText('The "Auto detect" may not be accurate');
                        }),
                        control: {
                            type: "dropdown",
                            key: "staticLanguage",
                            options: (() => {
                                // API states: For languages with variants (English, German, Portuguese)
                                // spell checking will only be activated when you specify the variant,
                                // e.g. en-GB instead of just en.
                                // Therefore we remove base languages (en, de, pt) that have other variants.
                                const staticLang = this.languages.filter(
                                    v =>
                                        v.longCode.length > 2 ||
                                        v.longCode !== v.code ||
                                        this.languages.filter(l => l.code == v.code).length <= 1,
                                );
                                return Object.fromEntries([
                                    ["", "Auto detect"],
                                    ...staticLang.map(v => [v.longCode, v.name]),
                                ]) as Record<string, string>;
                            })(),
                        },
                    },
                    {
                        type: "page",
                        name: "Language varieties",
                        desc: createFragment(frag => {
                            frag.appendText(
                                "Some languages have varieties depending on the country they are spoken in.",
                            );
                            frag.createEl("br");
                            frag.appendText(
                                'When "Auto detect" is active, these languages will be interpreted as the following variant.',
                            );
                        }),
                        items: LANGUAGE_VARIETIES.map(({ code, name, variants }) => ({
                            name: `Interpret ${name} as`,
                            control: {
                                type: "dropdown" as const,
                                key: `languageVariety.${code}`,
                                options: variants,
                            },
                        })),
                    },
                    {
                        name: "Mother tongue",
                        desc:
                            "Set mother tongue if you want to be warned about false friends when writing in other languages. " +
                            "This setting will also be used for automatic language detection.",
                        control: { type: "dropdown", key: "motherTongue", options: MOTHER_TONGUES },
                    },
                ],
            },
            {
                type: "page",
                name: "Spellcheck dictionary",
                desc: "Add words to the dictionary to avoid highlighting them as misspelled.",
                items: [
                    {
                        name: "Sync with LanguageTool",
                        control: { type: "toggle", key: "syncDictionary" },
                        visible: () => settings.options.endpoint === "premium",
                    },
                    sortedStrList("Ignored words", "dictionary"),
                ],
            },
            { type: "group" },
            {
                type: "page",
                name: "Categories and rules",
                desc: "Configure active and ignored categories and rules.",
                items: [
                    {
                        name: "Picky mode",
                        desc:
                            "Provides more style and tonality suggestions, " +
                            "detects long or complex sentences, " +
                            "recognizes colloquialism and redundancies, " +
                            "proactively suggests synonyms for commonly overused words",
                        control: { type: "toggle", key: "pickyMode" },
                    },
                    {
                        name: "Categories and rules",
                        desc: createFragment(frag => {
                            frag.appendText("You can enable or disable specific categories/rules.");
                            frag.createEl("br");
                            frag.createEl("a", {
                                text: "Click here for a list of rules and categories",
                                href: "https://community.languagetool.org/rule/list",
                                attr: { target: "_blank" },
                            });
                        }),
                    },
                    sortedStrList("Enabled categories", "enabledCategories", v => {
                        if (!/^[A-Z_]+$/.test(v))
                            return "Category name must be uppercase and underscore only";
                    }),
                    sortedStrList("Disabled categories", "disabledCategories", v => {
                        if (!/^[A-Z_]+$/.test(v))
                            return "Category name must be uppercase and underscore only";
                    }),
                    sortedStrList("Enabled rules", "enabledRules", v => {
                        if (!/^[A-Z_]+$/.test(v))
                            return "Rule name must be uppercase and underscore only";
                    }),
                    sortedStrList("Disabled rules", "disabledRules", v => {
                        if (!/^[A-Z_]+$/.test(v))
                            return "Rule name must be uppercase and underscore only";
                    }),
                ],
            },
            {
                type: "group",
                heading: "Advanced",
                items: [
                    {
                        name: "Long check notification",
                        desc: "Show the 'check spelling...' notification when a manual check is taking a long time.",
                        control: { type: "toggle", key: "longCheckNotification" },
                    },
                    {
                        name: "Inject property types",
                        desc: "Define the properties for note-specific LanguageTool settings.",
                        control: { type: "toggle", key: "injectProperties" },
                    },
                    {
                        name: "Copy error logs to clipboard",
                        desc: `${this.plugin.logs.length} messages`,
                        action: () => {
                            window.navigator.clipboard.writeText(this.plugin.logs.join("\n")).then(
                                () => new Notice("Logs copied to clipboard"),
                                () => new Notice("Failed to copy logs to clipboard"),
                            );
                        },
                    },
                ],
            },
        ];
    }
}
