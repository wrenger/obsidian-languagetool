export type Annotation = { text: string } | { markup: string, interpretAs?: string }

/** Annotated text with optional markup for LanguageTool */
export class AnnotatedText {
    annotations: Annotation[];

    constructor(annotations: Annotation[] = []) {
        this.annotations = annotations;
    }

    pushText(text: string) {
        this.annotations.push({ text });
    }

    pushMarkup(markup: string, interpretAs?: string) {
        this.annotations.push({ markup, interpretAs });
    }

    /** Merge compatible annotations to reduce the length */
    optimize() {
        let output: Annotation[] = [];
        for (let a of this.annotations) {
            if (("text" in a && a.text.length === 0) ||
                ("markup" in a && a.markup.length === 0 && a.interpretAs === undefined))
                continue;

            let last = output.at(-1);
            if (last === undefined) {
                output.push(a);
            } else {
                if ("text" in last && "text" in a) {
                    last.text += a.text;
                } else if ("markup" in last && "markup" in a && last.interpretAs === undefined) {
                    last.markup += a.markup;
                    last.interpretAs = a.interpretAs;
                } else {
                    output.push(a);
                }
            }
        }
        this.annotations = output;
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
                // markup is ignored and replaced
                from = Math.max(text.length, from - annotation.markup.length);
                to = Math.max(from, to - annotation.markup.length) + (annotation.interpretAs?.length ?? 0);
                text += annotation.interpretAs ?? "";
            }

            if (text.length >= to)
                return text.slice(from, to).trim();
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
