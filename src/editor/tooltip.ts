import { EditorView, Tooltip, hoverTooltip, showTooltip } from "@codemirror/view";
import { Extension, StateField } from "@codemirror/state";
import { categoryCssClass } from "../helpers";
import { ButtonComponent, setIcon } from "obsidian";
import { default as LanguageToolPlugin } from "main";
import { clearUnderlinesInRange, underlineDecoration, clearMatchingUnderlines } from "./underlines";
import * as api from "api";
import { SUGGESTIONS } from "settings";

function createTooltip(
    plugin: LanguageToolPlugin,
    view: EditorView,
    match: api.LTMatch,
    range: api.LTRange,
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
                            changes: [{ ...range, insert: btnText }],
                            effects: [clearUnderlinesInRange.of(range)],
                        });
                    });
                }
            });
        });

        root.createDiv({ cls: "lt-ignore-container" }, container => {
            if (category === "TYPOS") {
                container.createDiv({ cls: "lt-ignore-btn" }, button => {
                    setIcon(button.createSpan(), "plus-with-circle");
                    button.createSpan({ text: "Add to dictionary" });
                    button.onclick = async () => {
                        // Add to global dictionary
                        let dictionary = [...plugin.settings.options.dictionary, match.text.trim()];
                        await plugin.settings.update({ dictionary });
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
                        view.dispatch({ effects: [clearUnderlinesInRange.of(range)] });
                });
                if (category !== "SYNONYMS") {
                    container.createDiv({ cls: "lt-ignore-btn" }, button => {
                        setIcon(button.createSpan(), "circle-off");
                        button.createSpan({ text: "Disable rule" });
                        button.onclick = async () => {
                            let disabledRules = plugin.settings.options.disabledRules;
                            if (disabledRules) disabledRules += "," + ruleId;
                            else disabledRules = ruleId;
                            await plugin.settings.update({ disabledRules });

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
            popup.createDiv({ cls: "lt-info", text: `Text:\u00A0${match.text} (${range.from}-${range.to})` });
        });
    });
}

function lintTooltip(plugin: LanguageToolPlugin, view: EditorView, pos: number, side: -1 | 1): Tooltip | null {
    const state = view.state;
    const underlines = state.field(underlineDecoration);
    if (underlines.size === 0 || state.selection.ranges.length > 1) return null;

    let cursor = underlines.iter(pos);
    if (cursor.value != null && cursor.from <= pos && cursor.to >= pos) {
        // if cursor is on same position return to avoid duplicate tooltips
        const selection = state.selection.main;
        if (selection.from <= cursor.to && selection.to >= cursor.from) return null;

        let match = cursor.value.spec.underline as api.LTMatch;
        return {
            pos: cursor.from,
            end: cursor.to,
            above: true,
            strictSide: false,
            arrow: false,
            clip: false,
            create: view => ({
                dom: createTooltip(plugin, view, match, cursor),
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

export const buildCursorTooltip = (plugin: LanguageToolPlugin) => StateField.define<Tooltip | null>({
    create: () => null,
    update(tooltip, tr) {
        // Only update if selection or document changed to avoid flickering
        if (!tr.docChanged && !tr.selection) return tooltip;

        const state = tr.state;
        const selection = state.selection.main;
        const pos = selection.head;

        const underlines = state.field(underlineDecoration);
        if (underlines.size === 0) return null;

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
                create: (view) => {
                    const dom = createTooltip(plugin, view, match, { from: cursor.from, to: cursor.to });
                    dom.classList.add("cm-tooltip-hover"); // Add to hover class for same styling
                    return { dom };
                },
            };
        }

        return null;
    },
    provide: (f) => showTooltip.from(f),
});

    export const baseTheme = EditorView.baseTheme({
    ".cm-tooltip.cm-tooltip-hover, .cm-tooltip:has(.lt-tooltip)": {
        padding: "var(--size-2-3)",
        border: "1px solid var(--background-modifier-border-hover)",
        backgroundColor: "var(--background-secondary)",
        borderRadius: "var(--radius-m)",
        boxShadow: "var(--shadow-s)",
        zIndex: "var(--layer-menu)",
        userSelect: "none",
        overflow: "hidden",
    },
    ".lt-tooltip": {
        fontFamily: "var(--default-font)",
        fontSize: "var(--font-ui-small)",
        width: "300px",
        lineHeight: 1.5,

        "& > .lt-title": {
            display: "block",
            fontWeight: 600,
            marginBottom: "6px",
            padding: "0 12px",
            textDecoration: "underline 2px var(--lt-highlight)",
            "-webkit-text-decoration": "underline 2px var(--lt-highlight)",
        },
        "& > .lt-message": {
            display: "block",
            padding: "0 12px",
        },
        "& > .lt-bottom": {
            minHeight: "10px",
            padding: "0 12px",
            position: "relative",
            "& > .lt-buttoncontainer": {
                "&:not(:empty)": {
                    paddingTop: "10px",
                },
                "& > button": {
                    marginRight: "4px",
                    marginBottom: "4px",
                    padding: "4px 6px",
                }
            }
        },
        "& > .lt-ignore-container": {
            display: "flex",
            "& > .lt-ignore-btn": {
                fontSize: "var(--font-ui-small)",
                padding: "4px",
                display: "flex",
                flex: 1,
                width: "100%",
                textAlign: "left",
                alignItems: "center",
                lineHeight: 1,
                color: "var(--text-muted)",
                "& > span": {
                    display: "flex",
                    "&:last-child": {
                        marginLeft: "5px",
                    }
                },
                "&:hover": {
                    color: "var(--text-normal)",
                }
            },
            "& > .lt-info-container": {
                display: "flex",
                flex: 0,
                "& > .lt-info-button": {
                    color: "var(--text-faint)",
                    height: "100%",
                }
            }
        },
        "& > .lt-info-box": {
            padding: "5px 0px 0px 0px",
            overflowX: "scroll",
            color: "var(--text-muted)",
        }
    },
    ".lt-underline": {
        cursor: "pointer",
        transition: "background-color 100ms ease-out",
        textDecoration: "wavy underline var(--lt-highlight)",
        "-webkit-text-decoration": "wavy underline var(--lt-highlight)",
        "&:hover": {
            backgroundColor: "color-mix(in srgb, var(--lt-highlight), transparent 80%)",
        },
    },
});
