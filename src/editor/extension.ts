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
            position: "absolute",
            tooltipSpace: view => view.dom.getBoundingClientRect(),
        }),
        underlineDecoration,
        autoCheckListener(plugin),
    ];

    // TODO: Check if we can open the context menu on mobile!
    if (Platform.isMobile)
        extensions.push(buildTooltip(plugin));

    return extensions;
}
