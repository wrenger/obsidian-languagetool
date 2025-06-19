import { tooltips } from "@codemirror/view";
import LanguageToolPlugin from "main";
import { autoCheckListener } from "./autoCheck";
import { underlineDecoration } from "./underlines";
import { Extension } from "@codemirror/state";
import { buildTooltip } from "./tooltip";
import { Platform } from "obsidian";

export function underlineExtension(plugin: LanguageToolPlugin): Extension {
    let extensions = [
        tooltips({
            parent: document.body,
            tooltipSpace: view => view.dom.getBoundingClientRect(),
        }),
        underlineDecoration,
        autoCheckListener(plugin),
    ];

    if (Platform.isMobile) extensions.push(buildTooltip(plugin));

    return extensions;
}
