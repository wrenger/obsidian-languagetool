import {
    App,
    Command,
    Editor,
    MarkdownView,
    Menu,
    Notice,
    Plugin,
    PluginManifest,
    setIcon,
    setTooltip,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { ChangeSpec, StateEffect } from "@codemirror/state";
import {
    endpointFromUrl,
    LTOptions,
    LTSettings,
    LTSettingsTab,
    SettingsUpdateSource,
    SUGGESTIONS,
} from "./settings";
import * as api from "./api";
import { underlineExtension } from "./editor/extension";
import {
    addUnderline,
    clearAllUnderlines,
    clearMatchingUnderlines,
    clearUnderlinesInRange,
    underlineDecoration,
} from "./editor/underlines";
import { lintClass, cmpIgnoreCase, isWord } from "./helpers";
import * as markdown from "./markdown/parser";
import { RefreshableTask } from "./refreshableTask";

export default class LanguageToolPlugin extends Plugin {
    public settings: LTSettings;
    private statusBarItem?: HTMLElement;

    private isLoading = false;

    public logs: string[] = [];
    private settingTab: LTSettingsTab;
    private readonly languageTask: RefreshableTask;
    private readonly dictionaryTask: RefreshableTask;
    // Cached api key for dictionary tasks.
    private dictionaryApiKey?: string | null;

    // Used to temporarily disable auto-checking errors
    public autoCheckSuppressErrorsUntil: number = 0;

    constructor(app: App, manifest: PluginManifest) {
        super(app, manifest);

        this.settingTab = new LTSettingsTab(this.app, this);
        this.settings = new LTSettings(this.settingTab);
        this.languageTask = new RefreshableTask(
            async isCurrent => {
                const serverUrl = this.settings.options.serverUrl;
                const languages = await api.languages(serverUrl);
                if (isCurrent()) this.settingTab.setLanguages(languages);
            },
            {
                shouldRetry: api.isRetryableError,
                onError: error => console.error("Failed to load languages", error),
            },
        );
        this.dictionaryTask = new RefreshableTask(
            isCurrent => this.reconcileDictionary(isCurrent),
            {
                shouldRetry: api.isRetryableError,
                onError: error => {
                    this.pushLogs(error as Error);
                    console.error("Failed to sync dictionary with LanguageTool", error);
                },
            },
        );
    }

    public async onload(): Promise<void> {
        // Settings
        await this.settings.load();
        this.registerDomEvent(window, "online", () => {
            this.ensureNetworkTasks();
            this.languageTask.retry();
            this.dictionaryTask.retry();
        });
        this.register(() => {
            this.languageTask.dispose();
            this.dictionaryTask.dispose();
        });
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
        if (this.settings.options.injectProperties) this.injectProperties(true);

        // Spellcheck Dictionary
        await this.settings.update(current => {
            const dictionary = new Set(current.dictionary.map(w => w.trim()));
            dictionary.delete("");
            return { dictionary: [...dictionary].sort(cmpIgnoreCase) };
        });
        this.ensureNetworkTasks();
    }

    public onunload() {
        this.logs = [];
        this.isLoading = false;
    }

    // Configure frontmatter suggestions
    public injectProperties(inject: boolean) {
        const properties = {
            "lt-language": "text",
            "lt-picky": "checkbox",
            "lt-autoCheck": "checkbox",
            "lt-dictionary": "multitext",
            "lt-disabledRules": "multitext",
            "lt-disabledCategories": "multitext",
        };
        try {
            // WARNING: Internal API
            type MetadataTypeManager = {
                setType: (key: string, type: string) => void;
                unsetType: (key: string) => void;
            };
            // @ts-expect-error, not typed
            let typeManager = (this.app as { metadataTypeManager: MetadataTypeManager })
                .metadataTypeManager;
            for (const [key, type] of Object.entries(properties)) {
                if (inject) typeManager.setType(key, type);
                else typeManager.unsetType(key);
            }
        } catch {
            console.error("Failed to set metadata types");
        }
    }

    private registerCommands() {
        this.addCommand({
            id: "check",
            name: "Check text",
            icon: "spell-check",
            editorCallback: (editor, view) => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                this.runDetection(editorView).then(
                    suggestions => {
                        if (!suggestions) new Notice("No suggestions found.");
                    },
                    e => console.error(e),
                );
            },
        });
        this.addCommand({
            id: "toggle-auto-check",
            name: "Toggle automatic checking",
            icon: "uppercase-lowercase-a",
            callback: async () => {
                await this.settings.update({
                    shouldAutoCheck: !this.settings.options.shouldAutoCheck,
                });
            },
        });
        this.addCommand({
            id: "clear",
            name: "Clear suggestions",
            icon: "cross",
            editorCallback: editor => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                editorView.dispatch({ effects: [clearAllUnderlines.of(null)] });
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
                        let underline = (value.spec as { underline?: api.LTLint }).underline;
                        if (underline?.replacements?.length) {
                            changes.push({ from, to, insert: underline.replacements[0] });
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

        this.addCommand({
            id: "add-dict",
            name: "Add to dictionary",
            icon: "book-check",
            editorCheckCallback: (checking, editor) => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;

                let match = singleMatchAtCursor(editor, 0);
                if (!match) return checking ? false : undefined;
                if (!isWord(match.text)) return checking ? false : undefined;
                if (checking) return true;

                editorView.dispatch({
                    effects: [clearMatchingUnderlines.of(m => m.text == match.text)],
                });

                this.settings
                    .update(current => ({ dictionary: [...current.dictionary, match.text.trim()] }))
                    .then(
                        () => {},
                        e => {
                            console.error(e);
                            this.pushLogs(e as Error);
                        },
                    );
            },
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

                let match = singleMatchAtCursor(editor, n);
                if (!match) return checking ? false : undefined;
                if (checking) return true;

                // At this point, the check must have been successful.
                const change = { ...match.range, insert: match.replacements[n - 1] };

                // Insert the text of the match
                editorView.dispatch({
                    changes: [change],
                    effects: [clearUnderlinesInRange.of(match.range)],
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
            }),
        );
    }

    private populateSuggestionMenu(menu: Menu, editor: EditorView): boolean {
        const underlines = editor.state.field(underlineDecoration);
        const selection = editor.state.selection.main;

        let populated = false;
        const cursor = underlines.iter(selection.from);
        while (cursor.value != null && cursor.from <= selection.to) {
            populated = true;
            const match = (cursor.value.spec as { underline: api.LTMatch }).underline;
            menu.addItem(item => {
                item.setTitle(`LanguageTool (${match.text})`);
                item.setIcon("spell-check");
                item.setSection("spellcheck");
                // @ts-expect-error, not typed
                const submenu = (item as { setSubmenu: () => Menu }).setSubmenu();
                this.populateSuggestionSubmenu(submenu, match, cursor, editor);
            });
            cursor.next();
        }
        return populated;
    }

    public populateSuggestionSubmenu(
        submenu: Menu,
        match: api.LTMatch,
        range: api.LTRange,
        editor: EditorView,
    ): void {
        if (match.message || match.title) {
            submenu.addItem(item => {
                let title = new DocumentFragment();
                title.appendChild(
                    createDiv({ cls: "lt-menu-info" }, header => {
                        if (match.title)
                            header.createDiv({ text: match.title, cls: "lt-menu-title" });
                        if (match.message)
                            header.createDiv({ text: match.message, cls: "lt-menu-message" });
                    }),
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

        // single word lints
        if (isWord(match.text)) {
            submenu.addItem(subItem => {
                subItem.setTitle("Add to dictionary");
                subItem.setIcon("plus-with-circle");
                subItem.onClick(async () => {
                    await this.settings.update(current => ({
                        dictionary: [...current.dictionary, match.text.trim()].sort(cmpIgnoreCase),
                    }));
                    await this.syncDictionary();
                    editor.dispatch({
                        effects: [clearMatchingUnderlines.of(m => m.text === match.text)],
                    });
                });
            });
        }
        // Don't show this for obvious typos
        if (lintClass(match.categoryId, match.ruleId) !== "lt-major") {
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
                    subItem.onClick(async () => {
                        await this.settings.update(current => ({
                            disabledRules: [...current.disabledRules, match.ruleId].sort(
                                cmpIgnoreCase,
                            ),
                        }));

                        editor.dispatch({
                            effects: [clearMatchingUnderlines.of(m => m.ruleId === match.ruleId)],
                        });
                    });

                    // @ts-expect-error, not typed
                    const dom = subItem.dom as HTMLElement;
                    setTooltip(dom, `${match.categoryId} > ${match.ruleId}`);
                });
            }
        }
    }

    private showSynonyms(editor: Editor, checking: boolean = false): boolean {
        if (!this.settings.options.synonyms || !(this.settings.options.synonyms in api.SYNONYMS))
            return false;
        const synonyms = api.SYNONYMS[this.settings.options.synonyms];
        if (!synonyms) return false;

        // @ts-expect-error, not typed
        const editorView = editor.cm as EditorView;
        const selection = editorView.state.selection.main;
        if (selection.empty) return false;

        const word = editorView.state.sliceDoc(
            editorView.state.selection.main.from,
            editorView.state.selection.main.to,
        );
        if (word.match(/[\s.]/)) return false;

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

        synonyms.query(sentence, sel).then(
            replacements =>
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
                }),
            e => {
                const err = e as Error;
                console.error(err);
                this.pushLogs(err);
                new Notice(err.message, 30000);
            },
        );
        return true;
    }

    public setStatusBarReady() {
        this.isLoading = false;
        if (this.statusBarItem) setIcon(this.statusBarItem, "spell-check");
    }

    public setStatusBarWorking() {
        if (this.isLoading) return;

        this.isLoading = true;
        if (this.statusBarItem) setIcon(this.statusBarItem, "sync-small");
    }

    private handleStatusBarClick() {
        if (!this.statusBarItem) return;

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
                    this.settings.options.shouldAutoCheck
                        ? "Disable automatic checking"
                        : "Enable automatic checking",
                );
                item.setIcon("uppercase-lowercase-a");
                item.onClick(async () => {
                    await this.settings.update({
                        shouldAutoCheck: !this.settings.options.shouldAutoCheck,
                    });
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
                    editorView.dispatch({ effects: [clearAllUnderlines.of(null)] });
                });
            })
            .showAtPosition({ x: statusBarIconRect.right + 5, y: (statusBarRect?.top || 0) - 5 });
    }

    /**
     * Get the settings for the current file, where values might be reconfigured in the frontmatter.
     */
    public getActiveFileSettings(): LTOptions {
        const file = this.app.workspace.getActiveFile();
        const cache = file && this.app.metadataCache.getFileCache(file);

        // /* eslint-disable @typescript-eslint/no-unsafe-assignment */
        if (cache?.frontmatter != null) {
            const language: unknown =
                cache.frontmatter["lt-language"] ?? cache.frontmatter["lt_language"];
            const picky: unknown = cache.frontmatter["lt-picky"];
            const autoCheck: unknown = cache.frontmatter["lt-autoCheck"];
            const dictionary: unknown = cache.frontmatter["lt-dictionary"];
            const disabledRules: unknown = cache.frontmatter["lt-disabledRules"];
            const disabledCategories: unknown = cache.frontmatter["lt-disabledCategories"];

            // Beware: shallow clone
            let settings = { ...this.settings.options };
            if (typeof language === "string") settings.staticLanguage = language;
            if (typeof autoCheck === "boolean") settings.shouldAutoCheck = autoCheck;
            if (typeof picky === "boolean") settings.pickyMode = picky;
            if (Array.isArray(dictionary) && dictionary.every(item => typeof item === "string"))
                settings.dictionary = dictionary;
            if (
                Array.isArray(disabledRules) &&
                disabledRules.every(item => typeof item === "string")
            )
                settings.disabledRules = [...settings.disabledRules, ...disabledRules];
            if (
                Array.isArray(disabledCategories) &&
                disabledCategories.every(item => typeof item === "string")
            )
                settings.disabledCategories = [
                    ...settings.disabledCategories,
                    ...disabledCategories,
                ];
            return settings;
        }
        // /* eslint-enable @typescript-eslint/no-unsafe-assignment */
        return this.settings.options;
    }

    /**
     * Check the current document, adding underlines.
     */
    public async runDetection(
        editor: EditorView,
        auto: boolean = false,
        range?: api.LTRange,
    ): Promise<boolean> {
        let settings = this.getActiveFileSettings();

        const selection = editor.state.selection.main;
        if (!range && !selection.empty) range = { ...selection };

        const state = editor.state;
        const currentDoc = state.doc;
        const text = state.sliceDoc(); // handles line endings
        if (!text.trim()) return false;

        let matches: (api.LTMatch & { range: api.LTRange })[];
        let longNotice: Notice | undefined = undefined;
        let syntax: markdown.SyntaxTree;
        try {
            this.setStatusBarWorking();

            syntax = new markdown.SyntaxTree(text);

            let { offset, annotations } = syntax.annotate(range);
            // reduce request size
            offset += annotations.optimize();
            if (annotations.length() === 0) return false;
            // Notification for mobile devices, that do not have the status bar indicator
            if (settings.longCheckNotification && !auto && annotations.length() > 500)
                longNotice = new Notice("Checking spelling...", 30000);

            console.debug(`Checking ${annotations.length()} characters...`);
            // console.debug("Text", JSON.stringify(annotations, undefined, "  "));

            matches = await api.check(settings, this.settings.getApiKey(), offset, annotations);
            // update range to the checked text
            if (range) range = { from: offset, to: offset + annotations.length() };
        } catch (e) {
            console.error(e);
            if (e instanceof Error) {
                this.pushLogs(e);
                if (!auto) new Notice(e.message, 30000);
            }
            if (auto) throw e; // re-throw for auto-checks
            return true;
        } finally {
            this.setStatusBarReady();
            if (longNotice) longNotice.hide();
        }

        // Avoid updating the underlines if the document has changed
        // As the codemirror state is immutable, we can directly compare the text objects
        if (currentDoc !== editor.state.doc) return true;

        const effects: StateEffect<null | api.LTLint | api.LTRange>[] = [];

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
                if (
                    lintClass(match.categoryId, match.ruleId) === "lt-major" &&
                    spellcheckDictionary.includes(match.text.trim())
                )
                    continue;

                // Ignore whitespace lints inside tables
                if (
                    match.categoryId === "WHITESPACE" &&
                    (syntax.isInside(match.range.from, "table") ||
                        syntax.isInside(match.range.to, "table"))
                )
                    continue;

                // TODO: LanguageTool's ranges often include whitespace before/after lints.
                // As whitespace is used to hide markdown markup, applying these lints often breaks the format of
                // for example paragraphs, lists, or tables.

                effects.push(addUnderline.of(match));
            }
        }

        if (effects.length) {
            editor.dispatch({ effects });
        }
        console.debug(`Found ${effects.length - 1} suggestions.`);
        // reset auto-check disable on successful check
        this.autoCheckSuppressErrorsUntil = 0;
        return effects.length > 1;
    }

    /**
     * Add an error to the log.
     */
    private pushLogs(e: Error) {
        const debugString =
            `${new Date().toLocaleString()}:\n` +
            `Error: '${e.message}'\n` +
            `Settings: ${JSON.stringify({ ...this.settings.options, username: "REDACTED", apikey: "REDACTED" })}\n`;

        this.logs.push(debugString);
        if (this.logs.length > 10) this.logs.shift();
    }

    public ensureNetworkTasks(): void {
        const apiKey = this.settings.getApiKey();
        if (apiKey !== this.dictionaryApiKey) {
            this.dictionaryApiKey = apiKey;
            this.dictionaryTask.invalidate();
        }
        void this.languageTask.ensure();
        void this.dictionaryTask.ensure();
    }

    public onSettingsChanged(
        previous: Readonly<LTOptions>,
        source: SettingsUpdateSource = "local",
    ): void {
        const current = this.settings.options;
        if (previous.serverUrl !== current.serverUrl) {
            this.languageTask.invalidate();
            this.settingTab.setLanguages([]);
        }
        const dictionaryChanged =
            JSON.stringify(previous.dictionary) !== JSON.stringify(current.dictionary);
        if (source !== "local" && dictionaryChanged) this.settingTab.update();
        const connectionChanged =
            previous.serverUrl !== current.serverUrl ||
            previous.username !== current.username ||
            previous.apikeySecret !== current.apikeySecret ||
            previous.syncDictionary !== current.syncDictionary;
        if (
            connectionChanged ||
            (source !== "sync" &&
                (dictionaryChanged ||
                    JSON.stringify(previous.pendingDictEdits) !==
                        JSON.stringify(current.pendingDictEdits)))
        ) {
            this.dictionaryTask.invalidate();
        }
        this.ensureNetworkTasks();
    }

    public async onExternalSettingsChange() {
        const previous = this.settings.options;
        await this.settings.load();
        this.onSettingsChanged(previous, "external");
    }

    public async syncDictionary(): Promise<void> {
        this.dictionaryTask.invalidate();
        this.ensureNetworkTasks();
        await this.dictionaryTask.ensure();
    }

    private async reconcileDictionary(isCurrent: () => boolean): Promise<void> {
        if (!isCurrent()) return;
        const options = this.settings.options;
        const apiKey = this.settings.getApiKey();
        const current = () => isCurrent() && apiKey === this.settings.getApiKey();
        if (!options.syncDictionary || endpointFromUrl(options.serverUrl) !== "premium") return;

        const edits = options.pendingDictEdits;
        for (const edit of edits) {
            if (!current()) return;
            if (edit.present) await api.wordsAdd(options, apiKey, edit.word);
            else await api.wordsDel(options, apiKey, edit.word);
        }

        if (!current()) return;
        const dictionary = [...new Set(await api.words(options, apiKey))].sort(cmpIgnoreCase);
        if (current()) await this.settings.applyDictionarySync(dictionary, edits, current);
    }
}

function singleMatchAtCursor(editor: Editor, minReplacements: number = 1): api.LTLint | undefined {
    // @ts-expect-error, not typed
    const editorView = editor.cm as EditorView;
    const cursorOffset = editor.posToOffset(editor.getCursor());

    const matches: api.LTLint[] = [];

    // Get underline-matches at cursor
    editorView.state
        .field(underlineDecoration)
        .between(cursorOffset, cursorOffset, (from, to, value) => {
            let match = (value.spec as { underline?: api.LTMatch }).underline;
            if (match) matches.push({ ...match, range: { from, to } });
        });

    // Check that there is exactly one match that has a replacement in the slot that is called.
    if (!matches || matches.length !== 1) return undefined;
    const underline = matches[0];
    const preconditions = underline && underline.replacements.length >= minReplacements;
    return preconditions ? underline : undefined;
}
