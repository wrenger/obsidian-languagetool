export type Annotation = { text: string } | { markup: string; interpretAs?: string };

/** Annotated text with optional markup for LanguageTool */
export class AnnotatedText {
    annotations: Annotation[];

    constructor(annotations: Annotation[] = []) {
        this.annotations = annotations;
    }

    pushText(text: string) {
        if (text.length > 0) this.annotations.push({ text });
    }

    pushMarkup(markup: string, interpretAs?: string) {
        this.annotations.push({ markup, interpretAs });
    }

    extend(other: AnnotatedText) {
        for (const a of other.annotations) {
            if ("text" in a) this.pushText(a.text);
            else this.pushMarkup(a.markup, a.interpretAs);
        }
    }

    /** Merge compatible annotations to reduce the length, returning the start offset */
    optimize(): number {
        const output: Annotation[] = [];
        for (const a of this.annotations) {
            if (
                ("text" in a && a.text.length === 0) ||
                ("markup" in a && a.markup.length === 0 && !a.interpretAs)
            )
                continue;

            const last = output.at(-1);
            if (last === undefined) {
                output.push(a);
            } else {
                if ("text" in last && "text" in a) {
                    last.text += a.text;
                } else if ("markup" in last && "markup" in a) {
                    last.markup += a.markup;
                    if (last.interpretAs && a.interpretAs) last.interpretAs += a.interpretAs;
                    else if (a.interpretAs) last.interpretAs = a.interpretAs;
                } else {
                    output.push(a);
                }
            }
        }
        for (const a of output) {
            if ("markup" in a && a.interpretAs) {
                // replace more than two new lines with two new lines
                a.interpretAs = a.interpretAs.replace(/\n{3,}/g, "\n\n");
            }
        }
        // remove markup from the end
        for (let a = output.at(-1); a && "markup" in a; a = output.at(-1)) {
            output.pop();
        }
        // remove markup from the start
        let offset = 0;
        for (let a = output.at(0); a && "markup" in a; a = output.at(0)) {
            offset += a.markup.length;
            output.shift();
        }
        this.annotations = output;
        return offset;
    }

    /** Extract a subslice from the annotated text, ignoring any markup */
    extractSlice(from: number, to: number): string | null {
        let i = 0;
        for (; i < this.annotations.length; i++) {
            const annotation = this.annotations[i];
            const content = "text" in annotation ? annotation.text : annotation.markup;
            if (content.length < from) {
                from -= content.length;
                to -= content.length;
            } else {
                break;
            }
        }
        let text = "";
        for (; i < this.annotations.length; i++) {
            const annotation = this.annotations[i];
            if ("text" in annotation) {
                text += annotation.text;
            } else {
                if (text.length < from) {
                    from -= annotation.markup.length;
                    from += annotation.interpretAs?.length || 0;
                }
                text += annotation.interpretAs ?? "";
                to -= annotation.markup.length;
                to += annotation.interpretAs?.length || 0;
            }

            if (text.length >= to) return text.slice(from, to).trim();
        }
        return null;
    }

    length(): number {
        return this.annotations.reduce((acc, a) => {
            if ("text" in a) return acc + a.text.length;
            if ("markup" in a) return acc + a.markup.length;
            return acc;
        }, 0);
    }

    stringify(): string {
        return JSON.stringify({ annotation: this.annotations });
    }
}
