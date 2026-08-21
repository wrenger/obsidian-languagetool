import { EditorView, Decoration, DecorationSet } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import { categoryCssClass } from "../helpers";
import * as api from "../api";

export const ignoreListRegEx = /(frontmatter|code|math|templater|blockid|hashtag)/;

type UnderlineMatcher = (underline: api.LTMatch) => boolean;

/** Add new underline */
export const addUnderline = StateEffect.define<api.LTLint>();
/** Remove all underlines */
export const clearAllUnderlines = StateEffect.define();
/** Remove underlines in range */
export const clearUnderlinesInRange = StateEffect.define<api.LTRange>();
/** Ignore a specific underline */
export const clearMatchingUnderlines = StateEffect.define<UnderlineMatcher>();

function rangeOverlapping(first: api.LTRange, second: api.LTRange): boolean {
    return (
        (first.from <= second.from && second.from <= first.to) ||
        (first.from <= second.to && second.to <= first.to) ||
        (second.from <= first.from && first.from <= second.to) ||
        (second.from <= first.to && first.to <= second.to)
    );
}

export const underlineDecoration = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(underlines, tr) {
        underlines = underlines.map(tr.changes);

        // Clear out any decorations when their contents are edited
        if (tr.docChanged && tr.selection && underlines.size) {
            underlines = underlines.update({
                filter: (from, to) => !rangeOverlapping({ from, to }, tr.selection!.main),
            });
        }

        for (const e of tr.effects) {
            if (e.is(addUnderline)) {
                const underline = e.value;
                const range = underline.range;

                underlines = underlines.update({
                    add: [
                        Decoration.mark({
                            class: `lt-underline ${categoryCssClass(underline.categoryId)}`,
                            underline,
                        }).range(range.from, range.to),
                    ],
                });
            } else if (e.is(clearAllUnderlines)) {
                underlines = Decoration.none;
            } else if (e.is(clearUnderlinesInRange)) {
                underlines = underlines.update({
                    filterFrom: e.value.from,
                    filterTo: e.value.to,
                    filter: (from, to) => !rangeOverlapping({ from, to }, e.value),
                });
            } else if (e.is(clearMatchingUnderlines)) {
                underlines = underlines.update({
                    filter: (from, to, value) =>
                        !e.value((value.spec as { underline: api.LTLint }).underline),
                });
            }
        }

        return underlines;
    },
    provide: f => EditorView.decorations.from(f),
});
