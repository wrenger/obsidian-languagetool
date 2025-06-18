import { EditorView, Tooltip, TooltipView, showTooltip } from "@codemirror/view";
import { StateField, EditorState, Facet } from "@codemirror/state";
import { categoryCssClass } from "../helpers";
import { Menu, setIcon } from "obsidian";
import { default as LanguageToolPlugin } from "main";
import { clearUnderlinesInRange, underlineDecoration, clearMatchingUnderlines } from "./underlines";
import * as api from "api";
import { SUGGESTIONS } from "settings";

function createTooltip(
    plugin: LanguageToolPlugin,
    view: EditorView,
    underline: api.LTMatch
): HTMLElement {
    const buttons = underline.replacements.slice(0, SUGGESTIONS / 2);
    const category = underline.categoryId;
    const ruleId = underline.ruleId;

    return createDiv({ cls: ["lt-predictions-container", categoryCssClass(category)] }, root => {
        if (underline.title) {
            root.createSpan({ cls: "lt-title" }, span => {
                span.createSpan({ text: underline.title });
            });
        }

        if (underline.message) {
            root.createSpan({ cls: "lt-message", text: underline.message });
        }

        root.createDiv({ cls: "lt-bottom" }, bottom => {
            if (buttons.length > 0) {
                bottom.createDiv({ cls: "lt-buttoncontainer" }, container => {
                    for (const btnText of buttons) {
                        container.createEl("button", { text: btnText || "(delete)" }, button => {
                            button.onclick = () =>
                                view.dispatch({
                                    changes: [
                                        {
                                            from: underline.from,
                                            to: underline.to,
                                            insert: btnText,
                                        },
                                    ],
                                    effects: [clearUnderlinesInRange.of(underline)],
                                });
                        });
                    }
                });
            }
            bottom.createDiv({ cls: "lt-info-container" }, container => {
                container.createEl("button", { cls: "lt-info-button clickable-icon" }, button => {
                    setIcon(button, "info");
                    button.onclick = () => {
                        const popup = document.getElementsByClassName("lt-info-box").item(0);
                        if (popup) popup.toggleAttribute("hidden");
                    };
                });

                container.createDiv({ cls: "lt-info-box", attr: { hidden: true } }, popup => {
                    // \u00A0 is a non-breaking space
                    popup.createDiv({
                        cls: "lt-info",
                        text: `Category:\u00A0${category}`,
                    });
                    popup.createDiv({
                        cls: "lt-info",
                        text: `Rule:\u00A0${ruleId}`,
                    });
                });
            });
        });

        root.createDiv({ cls: "lt-ignorecontainer" }, container => {
            if (category === "TYPOS") {
                container.createEl("button", { cls: "lt-ignore-btn" }, button => {
                    setIcon(button.createSpan(), "plus-with-circle");
                    button.createSpan({
                        text: "Add to personal dictionary",
                    });
                    button.onclick = async () => {
                        // Add to global dictionary
                        plugin.settings.dictionary.push(underline.text);
                        await plugin.syncDictionary();

                        // Remove other underlines with the same word
                        view.dispatch({
                            effects: [
                                clearMatchingUnderlines.of(match => match.text === underline.text),
                            ],
                        });
                    };
                });
            } else {
                container.createEl("button", { cls: "lt-ignore-btn" }, button => {
                    setIcon(button.createSpan(), "cross");
                    button.createSpan({ text: "Ignore suggestion" });
                    button.onclick = () =>
                        view.dispatch({
                            effects: [clearUnderlinesInRange.of(underline)],
                        });
                });
                if (category !== "SYNONYMS") {
                    container.createEl("button", { cls: "lt-ignore-btn" }, button => {
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
        });
    });
}

function getTooltip(
    tooltips: readonly Tooltip[],
    plugin: LanguageToolPlugin,
    state: EditorState
): readonly Tooltip[] {
    const underlines = state.field(underlineDecoration);
    if (underlines.size === 0 || state.selection.ranges.length > 1) return [];

    let main = state.selection.main;
    // If the selection is too large, we don't show a tooltip
    if (main.to - main.from > 100) return [];

    let newTooltip: Tooltip | null = null;
    let cursor = underlines.iter(main.from);
    if (cursor.value != null && cursor.from <= main.to) {
        let match = cursor.value.spec.underline as api.LTMatch;
        newTooltip = {
            pos: cursor.from,
            end: cursor.to,
            above: true,
            strictSide: false,
            arrow: false,
            create: view => ({
                dom: createTooltip(plugin, view, match),
            }),
        };
    }
    // No changes to the tooltips, return the old ones
    if (
        newTooltip &&
        tooltips.length == 1 &&
        tooltips[0].pos === newTooltip.pos &&
        tooltips[0].end === newTooltip.end
    ) {
        return tooltips;
    }

    return newTooltip ? [newTooltip] : [];
}

export function buildTooltip(plugin: LanguageToolPlugin): StateField<readonly Tooltip[]> {
    return StateField.define<readonly Tooltip[]>({
        create: state => getTooltip([], plugin, state),
        update: (tooltips, tr) => getTooltip(tooltips, plugin, tr.state),
        provide: f => showTooltip.computeN([f], state => state.field(f)),
    });
}
