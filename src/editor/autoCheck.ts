import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import LanguageToolPlugin from "main";

export function autoCheckListener(plugin: LanguageToolPlugin): Extension {
    let debounceTimer = -1;
    let range = { from: Infinity, to: -Infinity };

    return EditorView.updateListener.of(update => {
        let settings = plugin.getActiveFileSettings();
        if (!update.docChanged || !settings.shouldAutoCheck) return;

        // Currently we have the issue that underlines sometimes do not move correctly
        // One problem might be that an update comes in between starting and applying a check

        update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
            range.from = Math.min(range.from, fromB, toB);
            range.to = Math.max(range.to, fromB, toB);
        });

        const view = update.view;
        clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(async () => {
            try {
                await plugin.runDetection(view, true, range);
            } catch (e) {
                console.error("Error during auto-check:", e);
            }

            range = { from: Infinity, to: -Infinity };
        }, plugin.settings.options.autoCheckDelay);
    });
}
