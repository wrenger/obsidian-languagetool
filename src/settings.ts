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

export interface LTSettings {
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

export const DEFAULT_SETTINGS: LTSettings = {
    serverUrl: endpoints["standard"].url,
    autoCheckDelay: endpoints.standard.minDelay,
    shouldAutoCheck: false,
    languageVariety: {
        en: "en-US",
        de: "de-DE",
        pt: "pt-PT",
        ca: "ca-ES",
    },
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

    private configureCheckDelay(slider: SliderComponent, value: EndpointType): void {
        const minAutoCheckDelay = endpoints[value].minDelay;
        this.plugin.settings.autoCheckDelay = Math.clamp(
            this.plugin.settings.autoCheckDelay,
            minAutoCheckDelay,
            autoCheckDelayMax
        );
        slider.setLimits(minAutoCheckDelay, autoCheckDelayMax, autoCheckDelayStep);
    }

    public async notifyEndpointChange(settings: LTSettings): Promise<void> {
        for (const listener of this.endpointListeners) {
            await listener(settings.serverUrl);
        }
    }

    private async configureLanguageVariants(
        dropdown: DropdownComponent,
        code: string
    ): Promise<void> {
        const languageVariety = this.plugin.settings.languageVariety;
        const variants = languageVariants(this.languages, code);
        languageVariety[code] = languageVariety[code] ?? Object.keys(variants)[0];

        dropdown
            .addOptions(variants)
            .setValue(languageVariety[code])
            .onChange(async value => {
                languageVariety[code] = value;
                await this.plugin.saveSettings();
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

        let endpoint = endpointFromUrl(settings.serverUrl);
        let autoCheckDelaySlider: SliderComponent | null = null;

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
                            settings.serverUrl = endpoints[endpoint].url;

                            if (input)
                                input.setValue(settings.serverUrl).setDisabled(value !== "custom");

                            if (autoCheckDelaySlider)
                                this.configureCheckDelay(autoCheckDelaySlider, endpoint);

                            await this.notifyEndpointChange(settings);

                            await this.plugin.saveSettings();
                        });
                });
                setting.addText(text => {
                    input = text;
                    text.setPlaceholder("https://your-custom-url.com")
                        .setValue(settings.serverUrl)
                        .setDisabled(endpoint !== "custom")
                        .onChange(async value => {
                            settings.serverUrl = value
                                .replace(/\/v2\/check\/$/, "")
                                .replace(/\/$/, "");

                            endpoint = endpointFromUrl(settings.serverUrl);
                            if (endpoint !== "custom") {
                                dropdown?.setValue(endpoint);
                                input?.setDisabled(true);
                            }

                            await this.notifyEndpointChange(settings);

                            await this.plugin.saveSettings();
                        });
                });
            });

        new Setting(containerEl)
            .setName("API username")
            .setDesc("Enter a username/mail for API access")
            .addText(text =>
                text
                    .setPlaceholder("peterlustig@example.com")
                    .setValue(settings.username || "")
                    .onChange(async value => {
                        settings.username = value.replace(/\s+/g, "");
                        await this.plugin.saveSettings();
                    })
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
                })
            )
            .addText(text =>
                text.setValue(settings.apikey || "").onChange(async value => {
                    settings.apikey = value.replace(/\s+/g, "");
                    if (settings.apikey && endpoint !== "premium") {
                        new Notice(
                            "You have entered an API Key but you are not using the Premium Endpoint"
                        );
                    }
                    await this.plugin.saveSettings();
                })
            );
        new Setting(containerEl)
            .setName("Auto check text")
            .setDesc("Check text as you type")
            .addToggle(component => {
                component.setValue(settings.shouldAutoCheck).onChange(async value => {
                    settings.shouldAutoCheck = value;
                    await this.plugin.saveSettings();
                });
            });
        new Setting(containerEl)
            .setName("Auto check delay (ms)")
            .setDesc("Time to wait for autocheck after the last key press")
            .addSlider(component => {
                autoCheckDelaySlider = component;

                this.configureCheckDelay(component, endpoint);
                component
                    .setValue(settings.autoCheckDelay)
                    .onChange(async value => {
                        settings.autoCheckDelay = value;
                        await this.plugin.saveSettings();
                    })
                    .setDynamicTooltip();
            });

        function synonymsDesc(frag: DocumentFragment): void {
            frag.appendText("Enables the context menu for synonyms fetched from");
            frag.createEl("br");
            if (settings.synonyms != null) {
                const synonyms = api.SYNONYMS[settings.synonyms];
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
            component.setValue(settings.synonyms ?? "none").onChange(async value => {
                settings.synonyms = value !== "none" ? value : undefined;
                await this.plugin.saveSettings();
                synonyms.setDesc(createFragment(synonymsDesc));
            });
        });

        new Setting(containerEl).setName("Language settings").setHeading();

        new Setting(containerEl)
            .setName("Mother tongue")
            .setDesc(
                "Set mother tongue if you want to be warned about false friends when writing in other languages. This setting will also be used for automatic language detection."
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
                                    .map(v => [v.longCode, v.name])
                            )
                        )
                        .setValue(settings.motherTongue ?? "none")
                        .onChange(async value => {
                            settings.motherTongue = value !== "none" ? value : undefined;
                            await this.plugin.saveSettings();
                        });
                });
            });

        new Setting(containerEl)
            .setName("Static language")
            .setDesc(
                "Set a static language that will always be used (LanguageTool tries to auto detect the language, this is usually not necessary)"
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
                            languages.filter(l => l.code == v.code).length <= 1
                    );

                    // Clear options
                    while (component.selectEl.options.length > 0) {
                        component.selectEl.remove(0);
                    }

                    component
                        .addOption("auto", "Auto Detect")
                        .addOptions(Object.fromEntries(staticLang.map(v => [v.longCode, v.name])))
                        .setValue(settings.staticLanguage ?? "auto")
                        .onChange(async value => {
                            settings.staticLanguage = value !== "auto" ? value : undefined;
                            await this.plugin.saveSettings();
                        });
                });
            });

        new Setting(containerEl)
            .setName("Language varieties")
            .setHeading()
            .setDesc("Some languages have varieties depending on the country they are spoken in.");

        const langVariants = {
            en: "English",
            de: "German",
            pt: "Portuguese",
            ca: "Catalan",
        };
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
                    .setValue(settings.syncDictionary)
                    .onChange(async value => {
                        settings.syncDictionary = value;
                        await this.plugin.syncDictionary();
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
                        "The picky mode enables a lot of extra categories and rules. Additionally, you can enable or disable specific rules down below."
                    );
                    frag.createEl("br");
                    frag.createEl("a", {
                        text: "Click here for a list of rules and categories",
                        href: "https://community.languagetool.org/rule/list",
                        attr: { target: "_blank" },
                    });
                })
            );

        new Setting(containerEl)
            .setName("Picky mode")
            .setDesc(
                "Provides more style and tonality suggestions, detects long or complex sentences, recognizes colloquialism and redundancies, proactively suggests synonyms for commonly overused words"
            )
            .addToggle(component => {
                component.setValue(settings.pickyMode).onChange(async value => {
                    settings.pickyMode = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Enabled categories")
            .setDesc("Comma-separated list of categories")
            .addText(text =>
                text
                    .setPlaceholder("CATEGORY_1,CATEGORY_2")
                    .setValue(settings.enabledCategories ?? "")
                    .onChange(async value => {
                        settings.enabledCategories = value.replace(/\s+/g, "");
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Disabled categories")
            .setDesc("Comma-separated list of categories")
            .addText(text =>
                text
                    .setPlaceholder("CATEGORY_1,CATEGORY_2")
                    .setValue(settings.disabledCategories ?? "")
                    .onChange(async value => {
                        settings.disabledCategories = value.replace(/\s+/g, "");
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Enabled rules")
            .setDesc("Comma-separated list of rules")
            .addText(text =>
                text
                    .setPlaceholder("RULE_1,RULE_2")
                    .setValue(settings.enabledRules ?? "")
                    .onChange(async value => {
                        settings.enabledRules = value.replace(/\s+/g, "");
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Disabled rules")
            .setDesc("Comma-separated list of rules")
            .addText(text =>
                text
                    .setPlaceholder("RULE_1,RULE_2")
                    .setValue(settings.disabledRules ?? "")
                    .onChange(async value => {
                        settings.disabledRules = value.replace(/\s+/g, "");
                        await this.plugin.saveSettings();
                    })
            );

        await this.notifyEndpointChange(settings);
    }
}

export class DictionaryModal extends Modal {
    plugin: LanguageToolPlugin;
    words: string[];

    constructor(app: App, plugin: LanguageToolPlugin) {
        super(app);
        this.setTitle("Spellcheck dictionary");
        this.plugin = plugin;
        this.words = plugin.settings.dictionary;
    }

    async onOpen() {
        this.words = this.plugin.settings.dictionary;
        const { contentEl } = this;

        const createButtons = (container: HTMLDivElement) => {
            container.replaceChildren(
                ...this.words.map(word =>
                    container.createDiv({ cls: "multi-select-pill" }, pill => {
                        pill.createDiv({ cls: "multi-select-pill-content" }, pill =>
                            pill.createSpan({ text: word })
                        );
                        pill.createDiv({ cls: "multi-select-pill-remove-button" }, remove => {
                            remove.appendChild(getIcon("x")!);
                            remove.onClickEvent(() => {
                                this.words.remove(word);
                                createButtons(container);
                            });
                        });
                    })
                )
            );
        };

        let buttonContainer: null | HTMLDivElement = null;
        contentEl.createDiv({ cls: "multi-select-container" }, container => {
            buttonContainer = container;
            createButtons(container);
        });

        this.plugin.syncDictionary().then(changed => {
            if (changed) {
                this.words = this.plugin.settings.dictionary;
                if (buttonContainer) createButtons(buttonContainer);
            }
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
        this.plugin.settings.dictionary = this.words;
        await this.plugin.syncDictionary();
    }
}
