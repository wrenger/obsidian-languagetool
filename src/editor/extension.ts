import LanguageToolPlugin from "main";
import { autoCheckListener } from "./autoCheck";
import { underlineDecoration } from "./underlines";
import { Extension } from "@codemirror/state";
import { baseTheme, buildHoverTooltip, buildCursorTooltip } from "./tooltip";

export function underlineExtension(plugin: LanguageToolPlugin): Extension {
    return [
        underlineDecoration,
        autoCheckListener(plugin),
        buildHoverTooltip(plugin),
        buildCursorTooltip(plugin),
        baseTheme,
    ];
}
