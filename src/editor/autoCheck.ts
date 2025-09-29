import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import LanguageToolPlugin from "main";

export function autoCheckListener(plugin: LanguageToolPlugin): Extension {
    let debounceTimer = -1;
    let minRange = Infinity;
    let maxRange = -Infinity;

    return EditorView.updateListener.of(update => {
        let settings = plugin.getActiveFileSettings();
        if (!update.docChanged || !settings.shouldAutoCheck) return;

        // Currently we have the issue that underlines sometimes do not move correctly
        // One problem might be that an update comes in between starting and applying a check

        update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
            minRange = Math.min(minRange, fromB, toB);
            maxRange = Math.max(maxRange, fromB, toB);
        });

        const view = update.view;
        clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
            plugin.runDetection(view, { from: minRange, to: maxRange }).catch(e => {
                console.error(e);
            });

            minRange = Infinity;
            maxRange = -Infinity;
        }, plugin.settings.options.autoCheckDelay);
    });
}
