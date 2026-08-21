import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import LanguageToolPlugin from "../main";
import { Notice } from "obsidian";

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
        window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
            const selection = range;
            range = { from: Infinity, to: -Infinity };

            plugin.runDetection(view, true, selection).then(
                () => {},
                e => {
                    const error = e as Error;
                    if (Date.now() > plugin.autoCheckSuppressErrorsUntil) {
                        // Prevent spamming errors
                        plugin.autoCheckSuppressErrorsUntil = Date.now() + 15 * 60_000; // 15 minutes
                        new Notice("Auto-check failed:\n" + error.message, 10000);
                    }
                    console.error("Auto-check failed", e);
                },
            );
        }, plugin.settings.options.autoCheckDelay);
    });
}
