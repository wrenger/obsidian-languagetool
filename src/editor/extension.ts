import { tooltips } from "@codemirror/view";
import LanguageToolPlugin from "main";
import { autoCheckListener } from "./autoCheck";
import { underlineDecoration } from "./underlines";
import { Extension } from "@codemirror/state";
import { buildHoverTooltip } from "./tooltip";

export function underlineExtension(plugin: LanguageToolPlugin): Extension {
    return [
        tooltips({
            parent: document.body,
            tooltipSpace: view => view.dom.getBoundingClientRect(),
        }),
        underlineDecoration,
        autoCheckListener(plugin),
        buildHoverTooltip(plugin),
    ];
}
