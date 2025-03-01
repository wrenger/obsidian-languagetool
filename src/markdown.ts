import type { RootContent, BlockContent, Text } from "mdast";
import type { Position } from "unist";
import { AnnotatedText } from "./annotated.js";

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { LTRange } from "./cm6/underlineField.js";

export namespace markdown {
    export async function parseAndAnnotate(
        text: string, range?: LTRange
    ): Promise<{ offset: number, annotations: AnnotatedText }> {
        let tree = fromMarkdown(text, {
            extensions: [gfm(), frontmatter(["yaml"])],
            mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml"])],
        });

        let annotator = new AnnotationVisitor(text, range);
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
            const position = node.position!!;
            const textLen = node.value.length + (node.value.split("\n").length - 1) * indent;
            const nodeLen = position.end.offset!! - position.start.offset!!;
            if (textLen < nodeLen) {
                // There are probably escape characters
                // It is not really clear why mdast did remove the escape nodes, but here we are

                // Find escapes
                let slice = this.raw.slice(position.start.offset!!, position.end.offset!!);
                let offset = 0;
                for (const match of slice.matchAll(/\\[[:punct:]]/g)) {
                    let start = match.index!!;
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
            this.offset = position.end.offset!!;
        }

        visitRoot(node: RootContent, indent: number) {
            if (node.position == null)
                throw Error("Markdown parsing: unknown position");

            const position = node.position!!;

            // Skip blocks outside of the range
            if (this.range && isBlock(node)) {
                // Skip blocks before the range
                if (position.end.offset!! <= this.range.from - 1)
                    return;
                // Skip blocks after the range
                if (position.start.offset!! >= this.range.to + 1) {
                    return;
                }

                // Block containing start
                if (position.start.offset!! <= this.range.from && this.range.from <= position.end.offset!!) {
                    this.output = new AnnotatedText();
                    this.offset = position.start.offset!!;
                    this.output_start = this.offset;
                    console.log("Start from", this.output_start);
                }

                // Block containing end
                if (position.start.offset!! <= this.range.to && this.range.to <= position.end.offset!!) {
                    this.output_end = position.end.offset!!;
                    console.log("End at", this.output_end);
                }
            }

            // Padding
            if (this.offset < position.start.offset!!) {
                this.output.pushMarkup(" ".repeat(position.start.offset!! - this.offset));
                this.offset = position.start.offset!!;
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
                    this.output.pushMarkup(emptyMarkup(position), node.value);
                    this.offset = position.end.offset!!;
                    break;
                case "break":
                    this.output.pushMarkup(emptyMarkup(position), "\n");
                    this.offset = position.end.offset!!;
                    break;
                case "blockquote":
                case "paragraph":
                    if (node.children.length > 0) {
                        let indent = node.children[0].position!!.start.column - 1;
                        node.children.forEach(child => this.visitRoot(child, indent));
                        this.output.pushMarkup("", "\n\n");
                    }
                    break;
                case "listItem":
                    if (node.children.length > 0) {
                        this.output.pushMarkup("", "• ");
                        let indent = node.children[0].position!!.start.column - 1;
                        node.children.forEach(child => this.visitRoot(child, indent));
                    }
                    break;
                case "link":
                    if (node.children) {
                        node.children.forEach(child => this.visitRoot(child, indent));
                    } else {
                        this.output.pushMarkup(emptyMarkup(position), "DUMMY");
                        this.offset = position.end.offset!!;
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
                    this.output.pushMarkup(emptyMarkup(position), "\n\n");
                    this.offset = position.end.offset!!;
                    break;
            }
        }

    }

    function addLines(text: string, indent: number, output: AnnotatedText) {
        let [first, ...reminder] = text.split("\n");
        output.pushText(first);
        for (const line of reminder) {
            output.pushMarkup(" ".repeat(indent));
            output.pushText("\n" + line);
        }
    }

    function emptyMarkup(pos: Position): string {
        return " ".repeat(pos.end.offset!! - pos.start.offset!!);
    }

    function isBlock(node: RootContent): node is BlockContent {
        return ["blockquote", "code", "heading", "html", "list", "paragraph", "table", "thematicBreak"].contains(node.type);
    }
};

export default markdown;
