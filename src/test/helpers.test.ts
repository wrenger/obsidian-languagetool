import { expect, test } from "bun:test";
import { isWord } from "../helpers";

test("isWord accepts words", () => {
    const words = [
        "word", "  word\t", "café", "cafe\u0301", "你好", "word123", "well-known", "word_name", "don't", "don’t",
        "word—word", "word+", "😀a", "w", "a.b", "a!b", "a(b)c",
        "-word", "word-", "_word", "word_", "-word_", "  _word-\t", "-a_", "_你-", "_😀a_", "-!a-",
    ];
    for (const text of words) {
        expect(isWord(text), JSON.stringify(text)).toBe(true);
    }
});

test("isWord rejects non-words", () => {
    const words = [
        "", " \t\n", "two words", "two\twords", "two\nwords", "two\r\nwords", "two\u00a0words", "two\u2003words",
        "word.", "word!", "(word)", "word。", ".", "  (word!)\t", "!word", "—word", "word—",
        "'word", "word’", "、word", "a b!c",
        "-", "_", "---", "___", "-_-_", "  -_-\t",
        "123", "😀", "_1-", "_😀_", "-!-", "+", "\u0301",
    ];
    for (const text of words) {
        expect(isWord(text), JSON.stringify(text)).toBe(false);
    }
});
