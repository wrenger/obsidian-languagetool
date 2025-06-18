import { describe, expect, test } from "@jest/globals";
import { parseAndAnnotate } from "../markdown/parser";
import { readdirSync, readFileSync } from "node:fs";

describe("markdown parsing", () => {
    test("hello world", async () => {
        let input = "Hello world";
        let { offset, annotations } = await parseAndAnnotate(input, undefined);
        expect(annotations.length()).toBe(input.length);
        expect(annotations.annotations[0]).toStrictEqual({ text: input });
    });

    test("wiki link", async () => {
        let input = "Hello [[World]]!";
        let { offset, annotations } = await parseAndAnnotate(input, undefined);
        expect(annotations.length()).toBe(input.length);
        expect(annotations.annotations[0]).toStrictEqual({ text: "Hello " });
        expect(annotations.annotations[1]).toStrictEqual({ markup: "  ", interpretAs: undefined });
        expect(annotations.annotations[2]).toStrictEqual({ text: "World" });
        expect(annotations.annotations[3]).toStrictEqual({ markup: "  ", interpretAs: undefined });
        expect(annotations.annotations[4]).toStrictEqual({ text: "!" });
    });

    test("wiki link with alias", async () => {
        let input = "Hello [[World|alias]]!";
        let { offset, annotations } = await parseAndAnnotate(input, undefined);
        console.info("annotations", annotations.annotations);
        expect(annotations.length()).toBe(input.length);
        expect(annotations.annotations[0]).toStrictEqual({ text: "Hello " });
        expect(annotations.annotations[1]).toStrictEqual({
            markup: "        ",
            interpretAs: undefined,
        });
        expect(annotations.annotations[2]).toStrictEqual({ text: "alias" });
        expect(annotations.annotations[3]).toStrictEqual({ markup: "  ", interpretAs: undefined });
        expect(annotations.annotations[4]).toStrictEqual({ text: "!" });
    });

    test("len error", async () => {
        let input = `
- EML attached
    - Here are some examples:
      Just padding text
      [[Here is some link]]
`;
        let { offset, annotations } = await parseAndAnnotate(input, undefined);
        console.info("Offset", offset);
        console.info("Annotations", annotations.annotations);
        expect(annotations.length()).toBe(input.trimEnd().length);
    });

    test("simple escape", async () => {
        let input = `Hello \\\\world`;
        let { offset, annotations } = await parseAndAnnotate(input, undefined);
        console.info("Offset", offset);
        console.info("Annotations", annotations.annotations);
        expect(annotations.length()).toBe(input.length);
        expect(annotations.annotations[0]).toStrictEqual({ text: "Hello " });
        expect(annotations.annotations[1]).toStrictEqual({ markup: " ", interpretAs: "" });
        expect(annotations.annotations[2]).toStrictEqual({ text: "\\" });
        expect(annotations.annotations[3]).toStrictEqual({ text: "world" });
    });

    test("many escapes", async () => {
        let input = `\\!\\"\\#\\$\\%\\&\\'\\(\\)\\*\\+\\,\\-\\.\\/\\:\\;\\<\\=\\>\\?\\@\\[\\\\\\]\\^\\_\\\`\\{\\|\\}\\~`;
        let { offset, annotations } = await parseAndAnnotate(input, undefined);
        console.info("Offset", offset);
        console.info("Annotations", annotations.annotations);
        expect(annotations.length()).toBe(input.length);
        for (let i = 0; i < input.length; i += 2) {
            expect(annotations.annotations[i]).toStrictEqual({ markup: " ", interpretAs: "" });
            expect(annotations.annotations[i + 1]).toStrictEqual({ text: input[i + 1] });
        }
        // ...
    });
});

describe("markdown samples", () => {
    // iterate over all files in the samples directory
    const files = readdirSync("test");
    for (const file of files) {
        test(`sample ${file}`, async () => {
            const input = readFileSync(`test/${file}`, "utf-8");
            const { offset, annotations } = await parseAndAnnotate(input, undefined);
            console.info(file, "Offset", offset);
            console.info(file, "Annotations", annotations.annotations);
            expect(annotations.length()).toBe(input.trimEnd().length);
        });
    }
});
