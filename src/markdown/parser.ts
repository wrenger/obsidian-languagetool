import type { RootContent, BlockContent, Text } from "mdast";

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";

import { AnnotatedText } from "../annotated";
import { wikiLink } from "./micromark-wikilink";
import { wikiLinkFromMarkdown } from "./mdast-wikilink";
import * as api from "../api";

const ESCAPE = /\\[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~]/g;

export async function parseAndAnnotate(
    text: string,
    range?: api.LTRange
): Promise<{ offset: number; annotations: AnnotatedText }> {
    const tree = fromMarkdown(text, {
        extensions: [gfm(), frontmatter(["yaml"]), wikiLink({ aliasDivider: "|" })],
        mdastExtensions: [
            gfmFromMarkdown(),
            frontmatterFromMarkdown(["yaml"]),
            wikiLinkFromMarkdown(),
        ],
    });

    const annotator = new AnnotationVisitor(text, range);
    try {
        tree.children.forEach(child => annotator.visitRoot(child));
    } catch (e) {
        console.error("Error while parsing markdown:\n", JSON.stringify(tree, undefined, "  "));
        throw e;
    }
    return { offset: annotator.output_start ?? 0, annotations: annotator.output };
}

class AnnotationVisitor {
    raw: string;
    output: AnnotatedText;
    output_start?: number;
    output_end?: number;
    offset: number;
    range?: api.LTRange;

    constructor(raw: string, range?: api.LTRange) {
        this.raw = raw;
        this.output = new AnnotatedText();
        this.offset = 0;
        this.range = range;
    }

    visitText(node: Text) {
        const startOffset = node?.position?.start.offset;
        const endOffset = node?.position?.end.offset;
        if (startOffset == null || endOffset == null) {
            throw Error("Markdown parsing: unknown position for text node");
        }

        const raw = this.raw.slice(startOffset, endOffset);
        addLines(raw, node.value, this.output);

        if (this.output.length() !== endOffset - (this.output_start || 0)) {
            console.error(
                "Invalid output length",
                this.output.length(),
                endOffset,
                JSON.stringify(node, undefined, "  ")
            );
            throw Error("Markdown parsing: invalid output length");
        }
        this.offset = endOffset;
    }

    visitRoot(node: RootContent) {
        if (node.position == null) throw Error("Markdown parsing: unknown position");

        const startOffset = node?.position?.start.offset;
        const endOffset = node?.position?.end.offset;
        if (startOffset == null || endOffset == null) {
            throw Error("Markdown parsing: unknown position for text node");
        }

        // Skip blocks outside of the range
        if (this.range && isBlock(node)) {
            // Skip blocks before the range
            if (endOffset <= this.range.from - 1) return;
            // Skip blocks after the range
            if (startOffset >= this.range.to + 1) {
                return;
            }

            // Block containing start
            if (startOffset <= this.range.from && this.range.from <= endOffset) {
                this.output = new AnnotatedText();
                this.offset = startOffset;
                this.output_start = this.offset;
                console.debug("Start from", this.output_start);
            }

            // Block containing end
            if (startOffset <= this.range.to && this.range.to <= endOffset) {
                this.output_end = endOffset;
                console.debug("End at", this.output_end);
            }
        }

        // Padding
        if (this.offset < startOffset) {
            this.output.pushMarkup(" ".repeat(startOffset - this.offset));
            this.offset = startOffset;
        }

        switch (node.type) {
            case "text":
                this.visitText(node);
                break;
            case "yaml":
            case "code":
            case "html":
            case "image":
            case "imageReference":
            case "footnoteReference":
            case "definition":
                break;
            case "strong":
            case "emphasis":
            case "delete":
            case "footnoteDefinition":
            case "linkReference":
                node.children.forEach(child => this.visitRoot(child));
                break;
            case "list":
            case "heading":
                node.children.forEach(child => this.visitRoot(child));
                this.output.pushMarkup("", "\n\n");
                break;
            case "inlineCode":
                this.output.pushMarkup(emptyMarkup(startOffset, endOffset), node.value);
                this.offset = endOffset;
                break;
            case "break":
                this.output.pushMarkup(emptyMarkup(startOffset, endOffset), "\n");
                this.offset = endOffset;
                break;
            case "blockquote":
            case "paragraph":
                if (node.children.length > 0) {
                    node.children.forEach(child => this.visitRoot(child));
                    this.output.pushMarkup("", "\n\n");
                }
                break;
            case "listItem":
                if (node.children.length > 0) {
                    this.output.pushMarkup("", "• ");
                    node.children.forEach(child => this.visitRoot(child));
                }
                break;
            case "link":
            case "wikiLink":
                if (node.children) {
                    node.children.forEach(child => this.visitRoot(child));
                } else {
                    this.output.pushMarkup(emptyMarkup(startOffset, endOffset), "DUMMY");
                    this.offset = endOffset;
                }
                break;
            case "table":
                this.output.pushMarkup("", "\n");
                node.children.forEach(child => this.visitRoot(child));
                break;
            case "tableRow":
                node.children.forEach(child => this.visitRoot(child));
                this.output.pushMarkup("", "\n\n");
                break;
            case "tableCell":
                node.children.forEach(child => this.visitRoot(child));
                this.output.pushMarkup("", "\n");
                break;
            case "thematicBreak":
                this.output.pushMarkup(emptyMarkup(startOffset, endOffset), "\n\n");
                this.offset = endOffset;
                break;
        }

        // Padding
        if (this.offset < endOffset) {
            this.output.pushMarkup(" ".repeat(endOffset - this.offset));
            this.offset = endOffset;
        }
    }
}

/// Adds text to the output, handling escape characters
function addText(text: string, output: AnnotatedText) {
    // There are probably escape characters
    // It is not really clear why mdast did remove the escape nodes, but here we are

    // Find escapes
    let offset = 0;
    for (const match of text.matchAll(ESCAPE)) {
        const start = match.index;
        // Could span over multiple lines
        output.pushText(text.slice(offset, start));
        output.pushMarkup(" ", ""); // backslash character
        output.pushText(text.slice(start + 1, start + 2));
        offset = start + 2;
    }
    output.pushText(text.slice(offset));
}

function addLines(text: string, parsed: string, output: AnnotatedText) {
    const [first, ...reminder] = text.replace(/\n$/, "").split("\n");
    const [pfirst, ...premider] = parsed.replace(/\n$/, "").split("\n");

    if (reminder.length !== premider.length) {
        console.error("Invalid number of lines", reminder.length, premider.length, text, parsed);
        throw Error("Markdown parsing: invalid number of lines");
    }

    addText(first, output);

    for (let i = 0; i < reminder.length; i++) {
        const line = reminder[i];
        const pline = premider[i];

        let indent = line.length - pline.length;
        for (const m of line.matchAll(ESCAPE)) {
            indent -= 1; // each escape character is one longer
        }
        if (indent < 0) {
            console.error("Invalid indent", indent, line, pline);
            throw Error("Markdown parsing: invalid indent");
        }

        output.pushText("\n");
        output.pushMarkup(" ".repeat(indent));
        addText(line.substring(indent), output);
    }
    if (text.endsWith("\n")) output.pushText("\n");
}

function emptyMarkup(startOffset: number, endOffset: number): string {
    return " ".repeat(endOffset - startOffset);
}

function isBlock(node: RootContent): node is BlockContent {
    return [
        "blockquote",
        "code",
        "heading",
        "html",
        "list",
        "paragraph",
        "table",
        "thematicBreak",
    ].contains(node.type);
}
