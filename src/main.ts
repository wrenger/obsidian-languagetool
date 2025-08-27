import {
    Command,
    Editor,
    MarkdownView,
    Menu,
    Notice,
    Plugin,
    setIcon,
    setTooltip,
} from "obsidian";
import { Decoration, EditorView } from "@codemirror/view";
import { ChangeSpec, StateEffect } from "@codemirror/state";
import {
    DEFAULT_SETTINGS,
    endpointFromUrl,
    LTSettings,
    LTSettingsTab,
    SUGGESTIONS,
} from "./settings";
import * as api from "api";
import { underlineExtension } from "./editor/extension";
import {
    addUnderline,
    clearAllUnderlines,
    clearMatchingUnderlines,
    clearUnderlinesInRange,
    underlineDecoration,
} from "./editor/underlines";
import { cmpIgnoreCase, setDifference, setIntersect, setUnion } from "./helpers";
import * as markdown from "./markdown/parser";

export default class LanguageToolPlugin extends Plugin {
    public settings: LTSettings;
    private statusBarItem: HTMLElement;

    private isLoading = false;

    public logs: string[] = [];
    private settingTab: LTSettingsTab;

    public async onload(): Promise<void> {
        // Settings
        await this.loadSettings();

        this.settingTab = new LTSettingsTab(this.app, this);
        this.addSettingTab(this.settingTab);

        // Status bar
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass("status-bar-item-icon", "lt-status-bar-btn");
        this.statusBarItem.onclick = () => this.handleStatusBarClick();
        this.setStatusBarReady();

        // Editor functionality
        this.registerEditorExtension(underlineExtension(this));

        // Commands
        this.registerCommands();

        this.registerMenuItems();

        // Configure frontmatter suggestions
        try {
            // WARNING: Internal API
            let typeManager = (this.app as any).metadataTypeManager;
            typeManager.setType("lt-language", "text");
            typeManager.setType("lt-picky", "checkbox");
            typeManager.setType("lt-autoCheck", "checkbox");
            typeManager.setType("lt-dictionary", "multitext");
            typeManager.setType("lt-disabledRules", "multitext");
            typeManager.setType("lt-disabledCategories", "multitext");
        } catch {
            console.error("Failed to set metadata types");
        }

        // Spellcheck Dictionary
        const dictionary: Set<string> = new Set(this.settings.dictionary.map(w => w.trim()));
        dictionary.delete("");
        this.settings.dictionary = [...dictionary].sort(cmpIgnoreCase);

        // Sync with language tool
        this.syncDictionary();

        await this.saveSettings();
    }

    public onunload() {
        this.logs = [];
        this.isLoading = false;
    }

    private registerCommands() {
        this.addCommand({
            id: "check",
            name: "Check text",
            icon: "spell-check",
            editorCallback: (editor, view) => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                this.runDetection(editorView)
                    .catch(e => console.error(e))
                    .then(suggestions => {
                        if (!suggestions) new Notice("No suggestions found.");
                    });
            },
        });
        this.addCommand({
            id: "toggle-auto-check",
            name: "Toggle automatic checking",
            icon: "uppercase-lowercase-a",
            callback: async () => {
                this.settings.shouldAutoCheck = !this.settings.shouldAutoCheck;
                await this.saveSettings();
            },
        });
        this.addCommand({
            id: "clear",
            name: "Clear suggestions",
            icon: "cross",
            editorCallback: editor => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                editorView.dispatch({
                    effects: [clearAllUnderlines.of(null)],
                });
            },
        });
        this.addCommand({
            id: "accept-all",
            name: "Accept all suggestions",
            icon: "circle-check-big",
            editorCallback: editor => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                const changes: ChangeSpec[] = [];
                const effects: StateEffect<api.LTRange>[] = [];
                editorView.state
                    .field(underlineDecoration)
                    .between(0, Infinity, (from, to, value) => {
                        if (value.spec?.underline?.replacements?.length) {
                            changes.push({
                                from,
                                to,
                                insert: value.spec.underline.replacements[0],
                            });
                            effects.push(clearUnderlinesInRange.of({ from, to }));
                        }
                    });
                editorView.dispatch({ changes, effects });
            },
        });
        this.addCommand({
            id: "next",
            name: "Jump to next suggestion",
            icon: "chevron-right",
            editorCheckCallback: (checking, editor) => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                const cursorOffset = editor.posToOffset(editor.getCursor());
                let firstMatch = null as { from: number; to: number } | null;
                editorView.state
                    .field(underlineDecoration)
                    .between(cursorOffset + 1, Infinity, (from, to) => {
                        if (!firstMatch || firstMatch.from > from) {
                            firstMatch = { from, to };
                        }
                    });
                if (checking) {
                    return firstMatch != null;
                }
                if (firstMatch != null) {
                    editorView.dispatch({
                        selection: { anchor: firstMatch.from, head: firstMatch.to },
                    });
                }
            },
        });
        for (let i = 1; i <= SUGGESTIONS; i++) {
            this.addCommand(this.applySuggestionCommand(i));
        }
        this.addCommand({
            id: "synonyms",
            name: "Show synonyms",
            icon: "square-stack",
            editorCheckCallback: (checking, editor) => this.showSynonyms(editor, checking),
        });
    }

    private applySuggestionCommand(n: number): Command {
        return {
            id: `accept-${n}`,
            name: `Accept suggestion ${n}`,
            icon: "circle-check",
            editorCheckCallback(checking, editor) {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                const cursorOffset = editor.posToOffset(editor.getCursor());

                const matches: {
                    from: number;
                    to: number;
                    value: Decoration;
                }[] = [];

                // Get underline-matches at cursor
                editorView.state
                    .field(underlineDecoration)
                    .between(cursorOffset, cursorOffset, (from, to, value) => {
                        matches.push({ from, to, value });
                    });

                // Check that there is exactly one match that has a replacement in the slot that is called.
                const preconditions =
                    matches.length === 1 &&
                    matches[0].value.spec?.underline?.replacements?.length >= n;

                if (checking) return preconditions;
                if (!preconditions) return;

                // At this point, the check must have been successful.
                const { from, to, value } = matches[0];
                const change = {
                    from,
                    to,
                    insert: value.spec.underline.replacements[n - 1],
                };

                // Insert the text of the match
                editorView.dispatch({
                    changes: [change],
                    effects: [clearUnderlinesInRange.of({ from, to })],
                });
            },
        };
    }

    private registerMenuItems() {
        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu, editor, view) => {
                console.debug(menu);

                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                this.populateSuggestionMenu(menu, editorView);

                if (this.showSynonyms(editor, true)) {
                    menu.addItem(item => {
                        item.setTitle("Synonyms");
                        item.setIcon("square-stack");
                        item.setSection("spellcheck");
                        item.onClick(() => this.showSynonyms(editor));
                    });
                }
            })
        );
    }

    private populateSuggestionMenu(menu: Menu, editor: EditorView): boolean {
        const underlines = editor.state.field(underlineDecoration);
        const selection = editor.state.selection.main;

        let populated = false;
        const cursor = underlines.iter(selection.from);
        while (cursor.value != null && cursor.from <= selection.to) {
            populated = true;
            const match = cursor.value.spec.underline as api.LTMatch;
            menu.addItem(item => {
                item.setTitle(`LanguageTool (${match.text})`);
                item.setIcon("spell-check");
                item.setSection("spellcheck");
                // @ts-expect-error, not typed
                const submenu: Menu = item.setSubmenu();
                this.populateSuggestionSubmenu(submenu, match, cursor, editor);
            });
            cursor.next();
        }
        return populated;
    }

    public populateSuggestionSubmenu(submenu: Menu, match: api.LTMatch, range: api.LTRange, editor: EditorView): void {
        if (match.message || match.title) {
            submenu.addItem(item => {
                let title = new DocumentFragment();
                title.appendChild(
                    createDiv({ cls: "lt-menu-info" }, header => {
                        if (match.title)
                            header.createDiv({ text: match.title, cls: "lt-menu-title" });
                        if (match.message)
                            header.createDiv({ text: match.message, cls: "lt-menu-message" });
                    })
                );
                item.setIsLabel(true);
                item.setTitle(title);
            });
            submenu.addSeparator();
        }

        for (const replacement of match.replacements.slice(0, SUGGESTIONS)) {
            submenu.addItem(item => {
                item.setTitle(replacement ? JSON.stringify(replacement) : "(delete)");
                item.onClick(() => {
                    editor.dispatch({
                        changes: { ...range, insert: replacement },
                        effects: [clearUnderlinesInRange.of(range)],
                    });
                });
            });
        }

        submenu.addSeparator();

        if (match.categoryId === "TYPOS") {
            submenu.addItem(subItem => {
                subItem.setTitle("Add to dictionary");
                subItem.setIcon("plus-with-circle");
                subItem.onClick(async () => {
                    this.settings.dictionary.push(match.text);
                    await this.syncDictionary();
                    editor.dispatch({
                        effects: [clearMatchingUnderlines.of(m => m.text === match.text)],
                    });
                });
            });
        } else {
            submenu.addItem(subItem => {
                subItem.setTitle("Ignore suggestion");
                subItem.setIcon("cross");
                subItem.onClick(() => {
                    editor.dispatch({ effects: [clearUnderlinesInRange.of(range)] });
                });
            });

            if (match.ruleId && match.ruleId !== "SYNONYMS") {
                submenu.addItem(subItem => {
                    subItem.setTitle("Disable rule");
                    subItem.setIcon("circle-off");
                    subItem.onClick(() => {
                        if (this.settings.disabledRules)
                            this.settings.disabledRules += "," + match.ruleId;
                        else this.settings.disabledRules = match.ruleId;
                        this.saveSettings();

                        editor.dispatch({
                            effects: [clearMatchingUnderlines.of(m => m.ruleId === match.ruleId)],
                        });
                    });

                    // @ts-expect-error, not typed
                    const dom = subItem.dom;
                    setTooltip(dom, `${match.categoryId} > ${match.ruleId}`);
                });
            }
        }
    }

    private showSynonyms(editor: Editor, checking: boolean = false): boolean {
        if (!this.settings.synonyms || !(this.settings.synonyms in api.SYNONYMS)) return false;
        const synonyms = api.SYNONYMS[this.settings.synonyms];
        if (!synonyms) return false;

        // @ts-expect-error, not typed
        const editorView = editor.cm as EditorView;
        const selection = editorView.state.selection.main;
        if (selection.empty) return false;

        const word = editorView.state.sliceDoc(
            editorView.state.selection.main.from,
            editorView.state.selection.main.to
        );
        if (word.match(/[\s\.]/)) return false;

        if (checking) return true;

        const line = editorView.state.doc.lineAt(selection.from);

        const prefix = line.text.slice(0, selection.from - line.from).lastIndexOf(".") + 1;
        const sentence_raw = line.text.slice(prefix);
        let sentence = sentence_raw.trimStart();
        const offset = line.from + prefix + sentence_raw.length - sentence.length;
        const sel = { from: selection.from - offset, to: selection.to - offset };

        sentence = sentence.trimEnd();
        const suffix = sentence.indexOf(".");
        if (suffix !== -1) sentence = sentence.slice(0, suffix + 1);

        synonyms
            .query(sentence, sel)
            .then(replacements =>
                editorView.dispatch({
                    effects: [
                        addUnderline.of({
                            text: word,
                            range: selection,
                            title: "Synonyms",
                            message: "",
                            categoryId: "SYNONYMS",
                            ruleId: "SYNONYMS",
                            replacements,
                        }),
                    ],
                })
            )
            .catch(e => {
                console.error(e);
                this.pushLogs(e);
                new Notice(e.message, 30000);
            });
        return true;
    }

    public setStatusBarReady() {
        this.isLoading = false;
        setIcon(this.statusBarItem, "spell-check");
    }

    public setStatusBarWorking() {
        if (this.isLoading) return;

        this.isLoading = true;
        setIcon(this.statusBarItem, "sync-small");
    }

    private handleStatusBarClick() {
        const statusBarRect = this.statusBarItem.getBoundingClientRect();
        const statusBarIconRect = this.statusBarItem.getBoundingClientRect();

        new Menu()
            .addItem(item => {
                item.setTitle("Check text");
                item.setIcon("spell-check");
                item.onClick(async () => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (view && view.getMode() === "source") {
                        // @ts-expect-error, not typed
                        const editorView = view.editor.cm as EditorView;
                        const suggestions = await this.runDetection(editorView);
                        if (!suggestions) new Notice("No suggestions found.");
                    }
                });
            })
            .addItem(item => {
                item.setTitle(
                    this.settings.shouldAutoCheck
                        ? "Disable automatic checking"
                        : "Enable automatic checking"
                );
                item.setIcon("uppercase-lowercase-a");
                item.onClick(async () => {
                    this.settings.shouldAutoCheck = !this.settings.shouldAutoCheck;
                    await this.saveSettings();
                });
            })
            .addItem(item => {
                item.setTitle("Clear suggestions");
                item.setIcon("cross");
                item.onClick(() => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view) return;

                    // @ts-expect-error, not typed
                    const editorView = view.editor.cm as EditorView;
                    editorView.dispatch({
                        effects: [clearAllUnderlines.of(null)],
                    });
                });
            })
            .showAtPosition({
                x: statusBarIconRect.right + 5,
                y: (statusBarRect?.top || 0) - 5,
            });
    }

    /**
     * Get the settings for the current file, where values might be reconfigured in the frontmatter.
     */
    public getActiveFileSettings(): LTSettings {
        const file = this.app.workspace.getActiveFile();
        const cache = file && this.app.metadataCache.getFileCache(file);

        if (cache?.frontmatter != null) {
            const language = cache.frontmatter["lt-language"] ?? cache.frontmatter["lt_language"];
            const picky = cache.frontmatter["lt-picky"];
            const autoCheck = cache.frontmatter["lt-autoCheck"];
            const dictionary = cache.frontmatter["lt-dictionary"];
            const disabledRules = cache.frontmatter["lt-disabledRules"];
            const disabledCategories = cache.frontmatter["lt-disabledCategories"];

            // Beware: shallow clone
            let settings = { ...this.settings };
            if (typeof language === "string") settings.staticLanguage = language;
            if (typeof autoCheck === "boolean") settings.shouldAutoCheck = autoCheck;
            if (typeof picky === "boolean") settings.pickyMode = picky;
            if (Array.isArray(dictionary)) settings.dictionary = dictionary;
            if (Array.isArray(disabledRules) && disabledRules.length)
                settings.disabledRules += "," + disabledRules.join(",");
            if (Array.isArray(disabledCategories) && disabledCategories.length)
                settings.disabledCategories += "," + disabledCategories.join(",");
            return settings;
        }
        return this.settings;
    }

    /**
     * Check the current document, adding underlines.
     */
    public async runDetection(editor: EditorView, range?: api.LTRange): Promise<boolean> {
        let settings = this.getActiveFileSettings();

        const selection = editor.state.selection.main;
        if (!range && !selection.empty) range = { ...selection };

        const text = editor.state.sliceDoc();
        if (!text.trim()) return false;

        let matches: (api.LTMatch & { range: api.LTRange })[];
        let longNotice: Notice | undefined = undefined;
        try {
            this.setStatusBarWorking();

            let { offset, annotations } = await markdown.parseAndAnnotate(text, range);
            // reduce request size
            offset += annotations.optimize();
            if (annotations.length() === 0) return false;
            if (annotations.length() > 500) longNotice = new Notice("Checking spelling...", 30000);

            console.info(`Checking ${annotations.length()} characters...`);
            console.debug("Text", JSON.stringify(annotations, undefined, "  "));

            matches = await api.check(settings, offset, annotations);
            // update range to the checked text
            if (range) range = { from: offset, to: offset + annotations.length() };
        } catch (e) {
            console.error(e);
            if (e instanceof Error) {
                this.pushLogs(e);
                new Notice(e.message, 30000);
            }
            return true;
        } finally {
            this.setStatusBarReady();
            if (longNotice) longNotice.hide();
        }

        const effects: StateEffect<any>[] = [];

        // remove previous underlines
        if (range) {
            effects.push(clearUnderlinesInRange.of(range));
        } else {
            effects.push(clearAllUnderlines.of(null));
        }

        if (matches) {
            const spellcheckDictionary = settings.dictionary;

            for (const match of matches) {
                // Fixes a bug where the match is outside the document
                if (match.range.to > editor.state.doc.length) continue;
                // Ignore typos that are in the spellcheck dictionary
                if (match.categoryId === "TYPOS" && spellcheckDictionary.includes(match.text))
                    continue;
                effects.push(addUnderline.of(match));
            }
        }

        if (effects.length) {
            editor.dispatch({ effects });
        }
        console.info(`Found ${effects.length - 1} suggestions.`);
        return effects.length > 1;
    }

    /**
     * Add an error to the log.
     */
    private async pushLogs(e: Error): Promise<void> {
        const debugString = `${new Date().toLocaleString()}:
Error: '${e.message}'
Settings: ${JSON.stringify({ ...this.settings, username: "REDACTED", apikey: "REDACTED" })}
`;

        this.logs.push(debugString);
        if (this.logs.length > 10) this.logs.shift();
    }

    public async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    public async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    public async onExternalSettingsChange() {
        this.settingTab.notifyEndpointChange(this.settings);
    }

    /**
     * Synchronizes with the LanguageTool dictionary,
     * returning whether the local dictionary has been changed.
     */
    public async syncDictionary(): Promise<boolean> {
        if (
            !this.settings.syncDictionary ||
            endpointFromUrl(this.settings.serverUrl) !== "premium"
        ) {
            await this.saveSettings();
            return false;
        }

        try {
            const lastWords = new Set(this.settings.remoteDictionary);
            let localWords = new Set(this.settings.dictionary);
            let remoteWords = new Set(await api.words(this.settings));

            // words that have been removed locally
            let localRemoved = setDifference(lastWords, localWords);
            localRemoved = setIntersect(localRemoved, remoteWords);
            for (const word of localRemoved) {
                await api.wordsDel(this.settings, word);
            }

            // words that have been removed remotely
            const remoteRemoved = setDifference(lastWords, remoteWords);

            remoteWords = setDifference(remoteWords, localRemoved);
            localWords = setDifference(localWords, remoteRemoved);

            // words that have been added locally
            const missingRemote = setDifference(localWords, remoteWords);
            for (const word of missingRemote) {
                await api.wordsAdd(this.settings, word);
            }

            // merge remaining words
            const words = setUnion(remoteWords, localWords);

            const oldLocal = new Set(this.settings.dictionary);
            const localChanged = oldLocal.size !== words.size;

            this.settings.dictionary = [...words].sort(cmpIgnoreCase);
            this.settings.remoteDictionary = [...words].sort(cmpIgnoreCase);
            await this.saveSettings();
            return localChanged;
        } catch (e) {
            this.pushLogs(e);
            new Notice(e.message, 30000);
            console.error("Failed sync spellcheck with LanguageTool", e);
        }
        await this.saveSettings();
        return false;
    }
}
