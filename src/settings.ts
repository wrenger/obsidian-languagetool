import {
    App,
    DropdownComponent,
    getIcon,
    Modal,
    Notice,
    PluginSettingTab,
    Setting,
    SliderComponent,
    TextComponent,
} from "obsidian";

import LanguageToolPlugin from "./main";
import * as api from "./api";
import { cmpIgnoreCase } from "./helpers";

const autoCheckDelayMax = 5000;
const autoCheckDelayStep = 250;

export const SUGGESTIONS = 8;

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
    standard: new Endpoint("https://api.languagetool.org", 20, 20000),
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

/** Wrapper for LanguageTool settings */
export abstract class LTSettings {
    private _options: LTOptions;
    constructor() {
        this._options = { ...DEFAULT_SETTINGS };
    }
    public get options(): Readonly<LTOptions> {
        return this._options;
    }
    public async update(options: Partial<LTOptions>): Promise<void> {
        const newOptions = { ...this._options, ...options };
        // Only save if something has changed
        if (JSON.stringify(newOptions) !== JSON.stringify(this._options)) {
            this._options = newOptions;
            await this.save(this._options);
        }
    }
    public async load(): Promise<void> {
        const options = await this.loadOptions();
        this._options = { ...DEFAULT_SETTINGS, ...options };
    }
    protected abstract loadOptions(): Promise<LTOptions>;
    protected abstract save(options: LTOptions): Promise<void>;
}

export interface LTOptions {
    serverUrl: string;
    apikey?: string;
    username?: string;

    shouldAutoCheck: boolean;
    autoCheckDelay: number;
    synonyms?: string;

    motherTongue?: string;
    staticLanguage?: string;
    languageVariety: Record<string, string>;

    dictionary: string[];
    syncDictionary: boolean;
    /// Snapshot of the last synchronization
    remoteDictionary: string[];

    pickyMode: boolean;
    enabledCategories?: string;
    disabledCategories?: string;
    enabledRules?: string;
    disabledRules?: string;
}

export const DEFAULT_SETTINGS: LTOptions = {
    serverUrl: endpoints["standard"].url,
    autoCheckDelay: endpoints.standard.minDelay,
    shouldAutoCheck: false,
    languageVariety: { en: "en-US", de: "de-DE", pt: "pt-PT", ca: "ca-ES" },
    dictionary: [],
    syncDictionary: false,
    remoteDictionary: [],
    pickyMode: false,
};

interface EndpointListener {
    (e: string): Promise<void>;
}
interface LanguageListener {
    (l: api.Language[]): Promise<void>;
}
function languageVariants(languages: api.Language[], code: string): Record<string, string> {
    languages = languages.filter(v => v.code === code).filter(v => v.longCode !== v.code);
    return Object.fromEntries(languages.map(v => [v.longCode, v.name]));
}

export class LTSettingsTab extends PluginSettingTab {
    private readonly plugin: LanguageToolPlugin;
    private endpointListeners: EndpointListener[] = [];
    private languageListeners: LanguageListener[] = [];
    private languages: api.Language[] = [];

    public constructor(app: App, plugin: LanguageToolPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private async configureCheckDelay(slider: SliderComponent, value: EndpointType): Promise<void> {
        const minAutoCheckDelay = endpoints[value].minDelay;
        await this.plugin.settings.update({
            autoCheckDelay: Math.clamp(
                this.plugin.settings.options.autoCheckDelay,
                minAutoCheckDelay,
                autoCheckDelayMax,
            ),
        });
        slider.setLimits(minAutoCheckDelay, autoCheckDelayMax, autoCheckDelayStep);
    }

    public async notifyEndpointChange(settings: Readonly<LTOptions>): Promise<void> {
        for (const listener of this.endpointListeners) {
            await listener(settings.serverUrl);
        }
    }

    private async configureLanguageVariants(
        dropdown: DropdownComponent,
        code: string,
    ): Promise<void> {
        const languageVariety = this.plugin.settings.options.languageVariety;
        const variants = languageVariants(this.languages, code);
        languageVariety[code] = languageVariety[code] ?? Object.keys(variants)[0];

        dropdown
            .addOptions(variants)
            .setValue(languageVariety[code])
            .onChange(async value => {
                languageVariety[code] = value;
                await this.plugin.settings.update({ languageVariety });
            });

        this.languageListeners.push(async l => {
            // Clear options
            while (dropdown.selectEl.options.length > 0) {
                dropdown.selectEl.remove(0);
            }

            const variants = languageVariants(l, code);
            languageVariety[code] = languageVariety[code] ?? Object.keys(variants)[0];
            dropdown.addOptions(variants).setValue(languageVariety[code]);
        });
    }

    public async display(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();

        const settings = this.plugin.settings;

        this.endpointListeners = [];
        this.endpointListeners.push(async url => {
            let lang: api.Language[] = [];
            if (url) lang = await api.languages(url);
            this.languages = lang;
            for (const listener of this.languageListeners) {
                await listener(lang);
            }
        });
        this.endpointListeners.push(async url => {
            await this.plugin.syncDictionary();
        });
        this.languageListeners = [];

        new Setting(containerEl)
            .setName("Error logs")
            .setDesc(`${this.plugin.logs.length} messages`)
            .addButton(component => {
                component.setButtonText("Copy to clipboard").onClick(async () => {
                    await window.navigator.clipboard.writeText(this.plugin.logs.join("\n"));
                    new Notice("Logs copied to clipboard");
                });
            });

        let endpoint = endpointFromUrl(settings.options.serverUrl);
        let autoCheckDelaySlider: SliderComponent | null = null;

        let endpointTimer: number | null = null;
        let endpointNotice: Notice | null = null;

        new Setting(containerEl)
            .setName("Endpoint")
            .setDesc("Choose the LanguageTool server url")
            .then(setting => {
                setting.controlEl.classList.add("lt-settings-grid");

                let dropdown: DropdownComponent | null = null;
                let input: TextComponent | null = null;
                setting.addDropdown(component => {
                    dropdown = component;
                    component
                        .addOptions({
                            standard: "(Standard) api.languagetool.org",
                            premium: "(Premium) api.languagetoolplus.com",
                            custom: "Custom URL",
                        })
                        .setValue(endpoint)
                        .onChange(async value => {
                            endpoint = value as EndpointType;
                            await settings.update({ serverUrl: endpoints[endpoint].url });

                            if (input)
                                input
                                    .setValue(settings.options.serverUrl)
                                    .setDisabled(value !== "custom");

                            if (autoCheckDelaySlider)
                                this.configureCheckDelay(autoCheckDelaySlider, endpoint);

                            await this.notifyEndpointChange(settings.options);
                        });
                });
                setting.addText(text => {
                    input = text;
                    text.setPlaceholder("http://your-custom-url.com")
                        .setValue(settings.options.serverUrl)
                        .setDisabled(endpoint !== "custom")
                        .onChange(async value => {
                            await settings.update({
                                serverUrl: value.replace(/\/v2\/check\/$/, "").replace(/\/$/, ""),
                            });

                            endpoint = endpointFromUrl(settings.options.serverUrl);
                            if (endpoint !== "custom") {
                                dropdown?.setValue(endpoint);
                                input?.setDisabled(true);
                            }

                            if (endpointTimer) window.clearTimeout(endpointTimer);
                            endpointTimer = window.setTimeout(async () => {
                                try {
                                    await this.notifyEndpointChange(settings.options);
                                    if (endpointNotice) endpointNotice.hide();
                                    endpointNotice = new Notice(
                                        "Successfully contacted LanguageTool server.",
                                        3000,
                                    );
                                } catch (error) {
                                    if (endpointNotice) endpointNotice.hide();
                                    endpointNotice = new Notice(
                                        `Error contacting LanguageTool server:\n${error.message}`,
                                        3000,
                                    );
                                }
                            }, 600);
                        });
                });
            });

        new Setting(containerEl)
            .setName("API username")
            .setDesc("Enter a username/mail for API access")
            .addText(text =>
                text
                    .setPlaceholder("peterlustig@example.com")
                    .setValue(settings.options.username || "")
                    .onChange(async value => {
                        await settings.update({ username: value.replace(/\s+/g, "") });
                    }),
            );
        new Setting(containerEl)
            .setName("API key")
            .setDesc(
                createFragment(frag => {
                    frag.createEl("a", {
                        text: "Click here for information about Premium Access",
                        href: "https://github.com/wrenger/obsidian-languagetool#premium-accounts",
                        attr: { target: "_blank" },
                    });
                }),
            )
            .addText(text =>
                text.setValue(settings.options.apikey || "").onChange(async value => {
                    await settings.update({ apikey: value.replace(/\s+/g, "") });
                    if (settings.options.apikey && endpoint !== "premium") {
                        new Notice(
                            "You have entered an API Key but you are not using the Premium Endpoint",
                        );
                    }
                }),
            );
        new Setting(containerEl)
            .setName("Auto check text")
            .setDesc("Check text as you type")
            .addToggle(component => {
                component.setValue(settings.options.shouldAutoCheck).onChange(async value => {
                    await settings.update({ shouldAutoCheck: value });
                });
            });
        new Setting(containerEl)
            .setName("Auto check delay (ms)")
            .setDesc("Time to wait for autocheck after the last key press")
            .addSlider(component => {
                autoCheckDelaySlider = component;

                this.configureCheckDelay(component, endpoint);
                component
                    .setValue(settings.options.autoCheckDelay)
                    .onChange(async value => {
                        await settings.update({ autoCheckDelay: value });
                    })
                    .setDynamicTooltip();
            });

        function synonymsDesc(frag: DocumentFragment): void {
            frag.appendText("Enables the context menu for synonyms fetched from");
            frag.createEl("br");
            if (settings.options.synonyms != null) {
                const synonyms = api.SYNONYMS[settings.options.synonyms];
                if (!synonyms) {
                    frag.appendText(" (unknown API)");
                    return;
                }
                frag.createEl("a", {
                    text: synonyms.url,
                    href: synonyms.url,
                    attr: { target: "_blank" },
                });
            } else {
                frag.appendText("(none)");
            }
        }

        const synonyms = new Setting(containerEl)
            .setName("Find synonyms")
            .setDesc(createFragment(synonymsDesc));
        synonyms.addDropdown(component => {
            component.addOption("none", "---");
            for (const lang of Object.keys(api.SYNONYMS)) {
                component.addOption(lang, lang);
            }
            component.setValue(settings.options.synonyms ?? "none").onChange(async value => {
                await settings.update({ synonyms: value !== "none" ? value : undefined });
                synonyms.setDesc(createFragment(synonymsDesc));
            });
        });

        new Setting(containerEl).setName("Language settings").setHeading();

        new Setting(containerEl)
            .setName("Mother tongue")
            .setDesc(
                "Set mother tongue if you want to be warned about false friends when writing in other languages. " +
                    "This setting will also be used for automatic language detection.",
            )
            .addDropdown(component => {
                this.languageListeners.push(async languages => {
                    // Clear options
                    while (component.selectEl.options.length > 0) {
                        component.selectEl.remove(0);
                    }

                    component
                        .addOption("none", "---")
                        .addOptions(
                            Object.fromEntries(
                                // only languages that are not dialects
                                languages
                                    .filter(v => v.longCode == v.code)
                                    .map(v => [v.longCode, v.name]),
                            ),
                        )
                        .setValue(settings.options.motherTongue ?? "none")
                        .onChange(async value => {
                            await settings.update({
                                motherTongue: value !== "none" ? value : undefined,
                            });
                        });
                });
            });

        new Setting(containerEl)
            .setName("Static language")
            .setDesc(
                "Set a static language that will always be used" +
                    "(LanguageTool tries to auto detect the language, this is usually not necessary)",
            )
            .addDropdown(component => {
                this.languageListeners.push(async languages => {
                    // API states: For languages with variants (English, German, Portuguese)
                    // spell checking will only be activated when you specify the variant,
                    // e.g. en-GB instead of just en.
                    // Therefore we remove base languages (en, de, pt) that have other variants.
                    const staticLang = languages.filter(
                        v =>
                            v.longCode.length > 2 ||
                            v.longCode !== v.code ||
                            languages.filter(l => l.code == v.code).length <= 1,
                    );

                    // Clear options
                    while (component.selectEl.options.length > 0) {
                        component.selectEl.remove(0);
                    }

                    component
                        .addOption("auto", "Auto Detect")
                        .addOptions(Object.fromEntries(staticLang.map(v => [v.longCode, v.name])))
                        .setValue(settings.options.staticLanguage ?? "auto")
                        .onChange(async value => {
                            await settings.update({
                                staticLanguage: value !== "auto" ? value : undefined,
                            });
                        });
                });
            });

        new Setting(containerEl)
            .setName("Language varieties")
            .setHeading()
            .setDesc("Some languages have varieties depending on the country they are spoken in.");

        const langVariants = { en: "English", de: "German", pt: "Portuguese", ca: "Catalan" };
        for (const [id, lang] of Object.entries(langVariants)) {
            new Setting(containerEl)
                .setName(`Interpret ${lang} as`)
                .addDropdown(async component => {
                    this.configureLanguageVariants(component, id);
                });
        }

        // ---------------------------------------------------------------------
        // Spellcheck
        // ---------------------------------------------------------------------
        new Setting(containerEl).setName("Spellcheck Dictionary").setHeading();

        new Setting(containerEl)
            .setName("Ignored Words")
            .setDesc("Words that should not be highlighted as spelling mistakes.")
            .addButton(component => {
                component
                    .setIcon("settings")
                    .setTooltip("Edit dictionary")
                    .onClick(() => {
                        new DictionaryModal(this.app, this.plugin).open();
                    });
            });

        new Setting(containerEl)
            .setName("Sync with LanguageTool")
            .setDesc("This is only supported for premium users.")
            .addToggle(component => {
                component
                    .setDisabled(endpoint !== "premium")
                    .setValue(settings.options.syncDictionary)
                    .onChange(async value => {
                        await settings.update({ syncDictionary: value });
                        if (value) await this.plugin.syncDictionary();
                    });
                this.endpointListeners.push(async url => {
                    component.setDisabled(endpointFromUrl(url) !== "premium");
                });
            });

        // ---------------------------------------------------------------------
        // Rules
        // ---------------------------------------------------------------------
        new Setting(containerEl)
            .setName("Rule categories")
            .setHeading()
            .setDesc(
                createFragment(frag => {
                    frag.appendText(
                        "The picky mode enables a lot of extra categories and rules. " +
                            "Additionally, you can enable or disable specific rules down below.",
                    );
                    frag.createEl("br");
                    frag.createEl("a", {
                        text: "Click here for a list of rules and categories",
                        href: "https://community.languagetool.org/rule/list",
                        attr: { target: "_blank" },
                    });
                }),
            );

        new Setting(containerEl)
            .setName("Picky mode")
            .setDesc(
                "Provides more style and tonality suggestions, " +
                    "detects long or complex sentences, " +
                    "recognizes colloquialism and redundancies, " +
                    "proactively suggests synonyms for commonly overused words",
            )
            .addToggle(component => {
                component.setValue(settings.options.pickyMode).onChange(async value => {
                    await settings.update({ pickyMode: value });
                });
            });

        new Setting(containerEl)
            .setName("Enabled categories")
            .setDesc("Comma-separated list of categories")
            .addText(text =>
                text
                    .setPlaceholder("CATEGORY_1,CATEGORY_2")
                    .setValue(settings.options.enabledCategories ?? "")
                    .onChange(async value => {
                        await settings.update({ enabledCategories: value.replace(/\s+/g, "") });
                    }),
            );

        new Setting(containerEl)
            .setName("Disabled categories")
            .setDesc("Comma-separated list of categories")
            .addText(text =>
                text
                    .setPlaceholder("CATEGORY_1,CATEGORY_2")
                    .setValue(settings.options.disabledCategories ?? "")
                    .onChange(async value => {
                        await settings.update({ disabledCategories: value.replace(/\s+/g, "") });
                    }),
            );

        new Setting(containerEl)
            .setName("Enabled rules")
            .setDesc("Comma-separated list of rules")
            .addText(text =>
                text
                    .setPlaceholder("RULE_1,RULE_2")
                    .setValue(settings.options.enabledRules ?? "")
                    .onChange(async value => {
                        await settings.update({ enabledRules: value.replace(/\s+/g, "") });
                    }),
            );

        new Setting(containerEl)
            .setName("Disabled rules")
            .setDesc("Comma-separated list of rules")
            .addText(text =>
                text
                    .setPlaceholder("RULE_1,RULE_2")
                    .setValue(settings.options.disabledRules ?? "")
                    .onChange(async value => {
                        await settings.update({ disabledRules: value.replace(/\s+/g, "") });
                    }),
            );

        await this.notifyEndpointChange(settings.options);
    }
}

export class DictionaryModal extends Modal {
    plugin: LanguageToolPlugin;
    words: string[];

    constructor(app: App, plugin: LanguageToolPlugin) {
        super(app);
        this.setTitle("Spellcheck dictionary");
        this.plugin = plugin;
        this.words = plugin.settings.options.dictionary;
    }

    async onOpen() {
        this.words = this.plugin.settings.options.dictionary;
        const { contentEl } = this;

        const createButtons = (container: HTMLDivElement) => {
            container.replaceChildren(
                ...this.words.map(word =>
                    container.createDiv({ cls: "multi-select-pill" }, pill => {
                        pill.createDiv({ cls: "multi-select-pill-content" }, content =>
                            content.createSpan({ text: word }),
                        );
                        pill.createDiv({ cls: "multi-select-pill-remove-button" }, remove => {
                            remove.appendChild(getIcon("x")!);
                            remove.onClickEvent(() => {
                                this.words.remove(word);
                                createButtons(container);
                            });
                        });
                    }),
                ),
            );
        };

        let buttonContainer: null | HTMLDivElement = null;
        contentEl.createDiv(
            { cls: ["multi-select-container", "lt-dictionary-words"] },
            container => {
                buttonContainer = container;
                createButtons(container);
            },
        );

        this.plugin.syncDictionary().then(() => {
            this.words = this.plugin.settings.options.dictionary;
            if (buttonContainer) createButtons(buttonContainer);
        });

        let newWord = "";
        let addComponent: null | TextComponent = null;
        const addWord = () => {
            if (newWord) {
                this.words = [...new Set([...this.words, newWord])].sort(cmpIgnoreCase);
                if (buttonContainer) createButtons(buttonContainer);
                if (addComponent) addComponent.setValue("");
                newWord = "";
            }
        };

        new Setting(contentEl)
            .setName("Add")
            .addText(component => {
                addComponent = component
                    .setValue(newWord)
                    .onChange(value => (newWord = value.trim()));
                component.inputEl.addEventListener("keypress", event => {
                    if (event.key === "Enter") addWord();
                });
            })
            .addExtraButton(component => {
                component
                    .setIcon("plus")
                    .setTooltip("Add")
                    .onClick(() => {
                        addWord();
                    });
            });
    }

    async onClose() {
        this.contentEl.empty();
        await this.plugin.settings.update({ dictionary: this.words });
        await this.plugin.syncDictionary();
    }
}
