import type { RootContent, BlockContent, Text } from "mdast";
import { AnnotatedText } from "../annotated.js";

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { LTRange } from "../cm6/underlineField.js";
import { wikiLink } from "./micromark-wikilink.js";
import { wikiLinkFromMarkdown } from "./mdast-wikilink.js";

export async function parseAndAnnotate(
    text: string,
    range?: LTRange,
): Promise<{ offset: number; annotations: AnnotatedText }> {
    const tree = fromMarkdown(text, {
        extensions: [gfm(), frontmatter(["yaml"]), wikiLink({ aliasDivider: "|" })],
        mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml"]), wikiLinkFromMarkdown()],
    });

    const annotator = new AnnotationVisitor(text, range);
    tree.children.forEach(child => annotator.visitRoot(child, 0));
    return { offset: annotator.output_start ?? 0, annotations: annotator.output };
}

class AnnotationVisitor {
    raw: string;
    output: AnnotatedText;
    output_start?: number;
    output_end?: number;
    offset: number;
    range?: LTRange;

    constructor(raw: string, range?: LTRange) {
        this.raw = raw;
        this.output = new AnnotatedText();
        this.offset = 0;
        this.range = range;
    }

    visitText(node: Text, indent: number) {
        const startOffset = node?.position?.start.offset;
        const endOffset = node?.position?.end.offset;
        if (startOffset == null || endOffset == null) {
            throw Error("Markdown parsing: unknown position for text node");
        }

        const textLen = node.value.length + (node.value.split("\n").length - 1) * indent;
        const nodeLen = endOffset - startOffset;
        if (textLen < nodeLen) {
            // There are probably escape characters
            // It is not really clear why mdast did remove the escape nodes, but here we are

            // Find escapes
            const slice = this.raw.slice(startOffset, endOffset);
            let offset = 0;
            for (const match of slice.matchAll(/\\[[:punct:]]/g)) {
                const start = match.index;
                // Could span over multiple lines
                addLines(slice.slice(offset, start), indent, this.output);
                this.output.pushMarkup(" ", ""); // backslash character
                this.output.pushText(slice.slice(start + 1, start + 2));
                offset = start + 2;
            }
            addLines(slice.slice(offset), indent, this.output);
        } else if (textLen > nodeLen) {
            console.error("Invalid length", textLen, nodeLen, JSON.stringify(node, undefined, "  "));
            throw Error("Markdown parsing: invalid text length");
        } else {
            // Default: no escapes
            addLines(node.value, indent, this.output);
        }
        this.offset = endOffset;
    }

    visitRoot(node: RootContent, indent: number) {
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
                console.log("Start from", this.output_start);
            }

            // Block containing end
            if (startOffset <= this.range.to && this.range.to <= endOffset) {
                this.output_end = endOffset;
                console.log("End at", this.output_end);
            }
        }

        // Padding
        if (this.offset < startOffset) {
            this.output.pushMarkup(" ".repeat(startOffset - this.offset));
            this.offset = startOffset;
        }

        switch (node.type) {
            case "text":
                this.visitText(node, indent);
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
                node.children.forEach(child => this.visitRoot(child, indent));
                break;
            case "list":
            case "heading":
                node.children.forEach(child => this.visitRoot(child, indent));
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
                    const column = node.children.at(0)?.position?.start?.column;
                    const ind = column != null ? column - 1 : indent;
                    node.children.forEach(child => this.visitRoot(child, ind));
                    this.output.pushMarkup("", "\n\n");
                }
                break;
            case "listItem":
                if (node.children.length > 0) {
                    this.output.pushMarkup("", "• ");
                    const column = node.children.at(0)?.position?.start?.column;
                    const ind = column != null ? column - 1 : indent;
                    node.children.forEach(child => this.visitRoot(child, ind));
                }
                break;
            case "link":
            case "wikiLink":
                if (node.children) {
                    node.children.forEach(child => this.visitRoot(child, indent));
                } else {
                    this.output.pushMarkup(emptyMarkup(startOffset, endOffset), "DUMMY");
                    this.offset = endOffset;
                }
                break;
            case "table":
                this.output.pushMarkup("", "\n");
                node.children.forEach(child => this.visitRoot(child, indent));
                break;
            case "tableRow":
                node.children.forEach(child => this.visitRoot(child, indent));
                this.output.pushMarkup("", "\n\n");
                break;
            case "tableCell":
                node.children.forEach(child => this.visitRoot(child, indent));
                this.output.pushMarkup("", "\n");
                break;
            case "thematicBreak":
                this.output.pushMarkup(emptyMarkup(startOffset, endOffset), "\n\n");
                this.offset = endOffset;
                break;
        }
    }
}

function addLines(text: string, indent: number, output: AnnotatedText) {
    const [first, ...reminder] = text.split("\n");
    output.pushText(first);
    for (const line of reminder) {
        output.pushMarkup(" ".repeat(indent));
        output.pushText("\n" + line);
    }
}

function emptyMarkup(startOffset: number, endOffset: number): string {
    return " ".repeat(endOffset - startOffset);
}

function isBlock(node: RootContent): node is BlockContent {
    return ["blockquote", "code", "heading", "html", "list", "paragraph", "table", "thematicBreak"].contains(node.type);
}
