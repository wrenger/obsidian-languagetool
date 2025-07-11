import { EditorView, Tooltip, hoverTooltip } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { categoryCssClass } from "../helpers";
import { ButtonComponent, setIcon } from "obsidian";
import { default as LanguageToolPlugin } from "main";
import { clearUnderlinesInRange, underlineDecoration, clearMatchingUnderlines } from "./underlines";
import * as api from "api";
import { SUGGESTIONS } from "settings";

function createTooltip(
    plugin: LanguageToolPlugin,
    view: EditorView,
    match: api.LTMatch
): HTMLElement {
    const replacements = match.replacements.slice(0, SUGGESTIONS / 2);
    const category = match.categoryId;
    const ruleId = match.ruleId;

    return createDiv({ cls: ["lt-tooltip", categoryCssClass(category)] }, root => {
        if (match.title) root.createSpan({ cls: "lt-title", text: match.title });
        if (match.message) root.createSpan({ cls: "lt-message", text: match.message });

        root.createDiv({ cls: "lt-bottom" }, bottom => {
            bottom.createDiv({ cls: "lt-buttoncontainer" }, container => {
                for (const btnText of replacements) {
                    const button = new ButtonComponent(container);
                    button.setButtonText(btnText || "(delete)");
                    button.onClick(() => {
                        view.dispatch({
                            changes: [{
                                from: match.from,
                                to: match.to,
                                insert: btnText,
                            }],
                            effects: [clearUnderlinesInRange.of(match)],
                        });
                    });
                }
            });
        });

        root.createDiv({ cls: "lt-ignorecontainer" }, container => {
            if (category === "TYPOS") {
                container.createEl("button", { cls: "lt-ignore-btn" }, button => {
                    setIcon(button.createSpan(), "plus-with-circle");
                    button.createSpan({ text: "Add to dictionary" });
                    button.onclick = async () => {
                        // Add to global dictionary
                        plugin.settings.dictionary.push(match.text);
                        await plugin.syncDictionary();
                        // Remove other underlines with the same word
                        view.dispatch({
                            effects: [
                                clearMatchingUnderlines.of(match => match.text === match.text),
                            ],
                        });
                    };
                });
            } else {
                container.createDiv({ cls: "lt-ignore-btn" }, button => {
                    setIcon(button.createSpan(), "cross");
                    button.createSpan({ text: "Ignore" });
                    button.onclick = () =>
                        view.dispatch({ effects: [clearUnderlinesInRange.of(match)] });
                });
                if (category !== "SYNONYMS") {
                    container.createDiv({ cls: "lt-ignore-btn" }, button => {
                        setIcon(button.createSpan(), "circle-off");
                        button.createSpan({ text: "Disable rule" });
                        button.onclick = () => {
                            if (plugin.settings.disabledRules)
                                plugin.settings.disabledRules += "," + ruleId;
                            else plugin.settings.disabledRules = ruleId;
                            plugin.saveSettings();

                            // Remove other underlines of the same rule
                            view.dispatch({
                                effects: [
                                    clearMatchingUnderlines.of(match => match.ruleId === ruleId),
                                ],
                            });
                        };
                    });
                }
            }
            container.createDiv({ cls: "lt-info-container" }, container => {
                container.createDiv({ cls: "lt-info-button clickable-icon" }, button => {
                    setIcon(button, "info");
                    button.onclick = () => {
                        const popup = document.getElementsByClassName("lt-info-box").item(0);
                        if (popup) popup.toggleAttribute("hidden");
                    };
                });
            });
        });
        root.createDiv({ cls: "lt-info-box", attr: { hidden: true } }, popup => {
            // \u00A0 is a non-breaking space
            popup.createDiv({ cls: "lt-info", text: `Category:\u00A0${category}` });
            popup.createDiv({ cls: "lt-info", text: `Rule:\u00A0${ruleId}` });
        });
    });
}

function lintTooltip(plugin: LanguageToolPlugin, view: EditorView, pos: number, side: -1 | 1): Tooltip | null {
    const state = view.state;
    const underlines = state.field(underlineDecoration);
    if (underlines.size === 0 || state.selection.ranges.length > 1) return null;

    let cursor = underlines.iter(pos);
    if (cursor.value != null && cursor.from <= pos && cursor.to >= pos) {
        let match = cursor.value.spec.underline as api.LTMatch;
        return {
            pos: cursor.from,
            end: cursor.to,
            above: true,
            strictSide: false,
            arrow: false,
            clip: false,
            create: view => ({
                dom: createTooltip(plugin, view, match),
            }),
        };
    }
    return null;
}

export function buildHoverTooltip(plugin: LanguageToolPlugin): Extension {
    return hoverTooltip(lintTooltip.bind(null, plugin), {
        hideOnChange: true,
    });
}
