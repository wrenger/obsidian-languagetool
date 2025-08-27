import { EditorView, Decoration, DecorationSet } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import { syntaxTree, tokenClassNodeProp } from "@codemirror/language";
import { Tree } from "@lezer/common";
import { categoryCssClass } from "../helpers";
import * as api from "api";

export const ignoreListRegEx = /(frontmatter|code|math|templater|blockid|hashtag)/;

type UnderlineMatcher = (underline: api.LTMatch) => boolean;

/** Add new underline */
export const addUnderline = StateEffect.define<(api.LTMatch & { range: api.LTRange })>();
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

        const seenRanges = new Set<string>();

        // Memoize any positions we check so we can avoid some work
        const seenPositions: Record<number, boolean> = {};
        let tree: Tree | null = null;

        // Prevent decorations in codeblocks, etc...
        const canDecorate = (pos: number) => {
            if (seenPositions[pos] == undefined) {
                if (!tree) tree = syntaxTree(tr.state);

                const nodeProps = tree.resolveInner(pos, 1).type.prop(tokenClassNodeProp);
                seenPositions[pos] = !(nodeProps && ignoreListRegEx.test(nodeProps));
            }
            return seenPositions[pos];
        };

        // Ignore certain rules in special cases
        const isRuleAllowed = (underline: api.LTMatch, range: api.LTRange) => {
            if (!tree) tree = syntaxTree(tr.state);

            // Don't display whitespace rules in tables
            const lineNodeProp = tree
                .resolve(tr.newDoc.lineAt(range.from).from, 1)
                .type.prop(tokenClassNodeProp);
            if (lineNodeProp?.includes("table")) {
                if (underline.ruleId === "WHITESPACE_RULE") {
                    return false;
                }
            }
            return true;
        };

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
                const key = `${range.from},${range.to}`;

                if (
                    !seenRanges.has(key) &&
                    canDecorate(range.from) &&
                    canDecorate(range.to) &&
                    isRuleAllowed(underline, range)
                ) {
                    seenRanges.add(key);
                    underlines = underlines.update({
                        add: [
                            Decoration.mark({
                                class: `lt-underline ${categoryCssClass(underline.categoryId)}`,
                                underline,
                            }).range(range.from, range.to),
                        ],
                    });
                }
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
                    filter: (from, to, value) => !e.value(value.spec.underline as api.LTMatch),
                });
            }
        }

        return underlines;
    },
    provide: f => EditorView.decorations.from(f),
});
