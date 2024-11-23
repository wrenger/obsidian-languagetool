import type { RootContent } from "mdast";
import type { Position } from "unist";
import { AnnotatedText } from "./annotated.js";

export namespace markdown {
    export async function parseAndAnnotate(text: string): Promise<AnnotatedText> {
        const { unified } = await import("unified");
        const remarkParse = (await import("remark-parse")).default;
        const remarkFrontmatter = (await import("remark-frontmatter")).default;
        const remarkGfm = (await import("remark-gfm")).default;

        let root = unified()
            .use(remarkParse)
            .use(remarkFrontmatter)
            .use(remarkGfm)
            .parse(text);

        let annotations = new AnnotatedText();
        console.debug("Markdown", JSON.stringify(root, undefined, "  "));
        toAnnotated(text, root.children, 0, annotations, 0);
        return annotations;
    }

    function toAnnotated(raw: string, nodes: RootContent[], offset: number, output: AnnotatedText, indent: number): number {
        function emptyMarkup(pos: Position): string {
            return " ".repeat(pos.end.offset!! - pos.start.offset!!);
        }

        for (const node of nodes) {
            if (node.position == null)
                throw Error("Markdown parsing: unknown position");

            const position = node.position!!;

            // Padding
            if (offset < position.start.offset!!) {
                output.pushMarkup(" ".repeat(position.start.offset!! - offset));
                offset = position.start.offset!!;
            }

            switch (node.type) {
                case "text":

                    function addLines(text: string, indent: number, output: AnnotatedText) {
                        let [first, ...reminder] = text.split("\n");
                        output.pushText(first);
                        for (const line of reminder) {
                            output.pushMarkup(" ".repeat(indent));
                            output.pushText("\n" + line);
                        }
                    }

                    const textLen = node.value.length + (node.value.split("\n").length - 1) * indent;
                    const nodeLen = position.end.offset!! - position.start.offset!!;
                    if (textLen < nodeLen) {
                        // There are probably escape characters
                        // It is not really clear why mdast did remove the escape nodes, but here we are

                        // Find escapes
                        let slice = raw.slice(position.start.offset!!, position.end.offset!!);
                        let offset = 0;
                        for (const match of slice.matchAll(/\\[[:punct:]]/g)) {
                            let start = match.index!!;
                            // Could span over multiple lines
                            addLines(slice.slice(offset, start), indent, output);
                            output.pushMarkup(" ", ""); // backslash character
                            output.pushText(slice.slice(start + 1, start + 2));
                            offset = start + 2;
                        }
                        addLines(slice.slice(offset), indent, output);
                    } else if (textLen > nodeLen) {
                        console.error("Invalid length", textLen, nodeLen, JSON.stringify(node, undefined, "  "));
                        throw Error("Markdown parsing: invalid text length");
                    } else {
                        // Default: no escapes
                        addLines(node.value, indent, output);
                    }

                    offset = position.end.offset!!;
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
                    offset = toAnnotated(raw, node.children, offset, output, indent);
                    break;
                case "list":
                case "heading":
                    offset = toAnnotated(raw, node.children, offset, output, indent);
                    output.pushMarkup("", "\n\n");
                    break;
                case "inlineCode":
                    output.pushMarkup(emptyMarkup(position), node.value);
                    offset = position.end.offset!!;
                    break;
                case "blockquote":
                    if (node.children.length > 0)
                        offset = toAnnotated(raw, node.children, offset, output, node.children[0].position!!.start.column - 1);
                    break;
                case "break":
                    output.pushMarkup(emptyMarkup(position), "\n");
                    offset = position.end.offset!!;
                    break;
                case "paragraph":
                    output.pushMarkup("", "\n\n");
                    if (node.children.length > 0) {
                        offset = toAnnotated(raw, node.children, offset, output, node.children[0].position!!.start.column - 1);
                        output.pushMarkup("", "\n\n");
                    }
                    break;
                case "listItem":
                    if (node.children.length > 0) {
                        output.pushMarkup("", "• ");
                        offset = toAnnotated(raw, node.children, offset, output, node.children[0].position!!.start.column - 1);
                    }
                    break;
                case "link":
                    if (node.children) {
                        offset = toAnnotated(raw, node.children, offset, output, indent);
                    } else {
                        output.pushMarkup(emptyMarkup(position), "DUMMY");
                        offset = position.end.offset!!;
                    }
                    break;
                case "table":
                    output.pushMarkup("", "\n");
                    offset = toAnnotated(raw, node.children, offset, output, indent);
                    break;
                case "tableRow":
                    offset = toAnnotated(raw, node.children, offset, output, indent);
                    output.pushMarkup("", "\n\n");
                    break;
                case "tableCell":
                    offset = toAnnotated(raw, node.children, offset, output, indent);
                    output.pushMarkup("", "\n");
                    break;
                case "thematicBreak":
                    output.pushMarkup(emptyMarkup(position), "\n\n");
                    offset = position.end.offset!!;
                    break;
            }
        }

        return offset;
    }
};

export default markdown;
