import { endpointFromUrl, LTOptions } from "./settings";
import { RequestUrlParam, RequestUrlResponse, requestUrl } from "obsidian";
import { JSONPath } from "jsonpath-plus";
import { AnnotatedText } from "./annotated";
import { errorMessage } from "./helpers";

/** LanguageTool Check API: https://languagetool.org/http-api/swagger-ui */

/** A typo or grammar issue detected by LanguageTool */
export interface LTMatch {
    text: string;
    title: string;
    message: string;
    replacements: string[];
    categoryId: string;
    ruleId: string;
}

export interface LTRange {
    from: number;
    to: number;
}

export interface LTLint extends LTMatch {
    range: LTRange;
}

type JsonValue = string | number | boolean | { [x: string]: JsonValue } | JsonValue[] | null;

/**
 * The main function of LanguageTool, checking text for spell/grammar errors.
 */
export async function check(
    options: Readonly<LTOptions>,
    apiKey: string | null,
    offset: number,
    annotated: AnnotatedText,
): Promise<LTLint[]> {
    const data = annotated.stringify();

    const lang = options.staticLanguage || "auto";
    const params: { [key: string]: string } = {
        data,
        language: lang,
        enabledOnly: "false",
        level: options.pickyMode ? "picky" : "default",
    };

    if (options.motherTongue) params.motherTongue = options.motherTongue;

    if (options.enabledCategories.length)
        params.enabledCategories = options.enabledCategories.join(",");
    if (options.disabledCategories.length)
        params.disabledCategories = options.disabledCategories.join(",");

    if (options.enabledRules.length) params.enabledRules = options.enabledRules.join(",");
    if (options.disabledRules.length) params.disabledRules = options.disabledRules.join(",");

    if (lang == "auto") {
        params.preferredVariants = Object.values(options.languageVariety).join(",");
        if (options.preferredLanguages.length)
            params.preferredLanguages = options.preferredLanguages.join(",");
    }

    const endpointType = endpointFromUrl(options.serverUrl);
    if (endpointType !== "public" && apiKey && options.username) {
        params.username = options.username;
        params.apiKey = apiKey;
    }

    const res = await requestUrlChecked({
        url: `${options.serverUrl}/v2/check`,
        method: "POST",
        body: new URLSearchParams(params).toString(),
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
    });

    if (res.json == null) throw new Error(`Error processing response from LanguageTool.`);

    const matches = jsonPathA<JsonValue>("$.matches[*]", res.json as JsonValue);
    return matches.map(match => {
        const from = jsonPath<number>("$.offset@number()", match);
        const to = from + jsonPath<number>("$.length@number()", match);
        return {
            range: { from: offset + from, to: offset + to },
            text: annotated.extractSlice(from, to) || "",
            title: jsonPath<string>("$.shortMessage@string()", match),
            message: jsonPath<string>("$.message@string()", match),
            replacements: jsonPathA<string>("$.replacements[*].value@string()", match),
            categoryId: jsonPath<string>("$.rule.category.id@string()", match),
            ruleId: jsonPath<string>("$.rule.id@string()", match),
        };
    });
}

export interface Language {
    name: string;
    code: string;
    longCode: string;
}

/// Short timeout, as this is called during startup.
const LANG_TIMEOUT = 3000;

export async function languages(serverUrl: string): Promise<Language[]> {
    let res = await requestUrlChecked({ url: `${serverUrl}/v2/languages` }, LANG_TIMEOUT);
    let languages = res.json as JsonValue;
    if (languages == null || !(languages instanceof Array))
        throw new Error(`Error processing response from LanguageTool.`);
    // @ts-expect-error, not typed
    return languages as Language[];
}

export async function words(
    options: Readonly<LTOptions>,
    apiKey: string | null,
): Promise<string[]> {
    if (options.username == null || apiKey == null)
        throw Error(`Syncing words is only supported for premium users`);

    try {
        const limit = 1000;
        const words: string[] = [];
        for (let offset = 0; ; offset += limit) {
            const res = (
                await requestUrlChecked({
                    url: sUrl(`${options.serverUrl}/v2/words`, {
                        username: options.username,
                        apiKey: apiKey,
                        offset: String(offset),
                        limit: String(limit),
                    }).href,
                })
            ).json as JsonValue;
            const page = jsonPathA<string>("$.words[*]@string()", res);
            words.push(...page);
            if (page.length < limit) return words;
        }
    } catch (e) {
        throw new Error(`Requesting words failed\n${errorMessage(e)}`, { cause: e });
    }
}
export async function wordsAdd(
    options: Readonly<LTOptions>,
    apiKey: string | null,
    word: string,
): Promise<boolean> {
    if (options.username == null || apiKey == null)
        throw Error(`Syncing words is only supported for premium users`);

    try {
        const res = (
            await requestUrlChecked(
                {
                    url: sUrl(`${options.serverUrl}/v2/words/add`, {
                        username: options.username,
                        apiKey: apiKey,
                        word,
                    }).href,
                    method: "POST",
                },
                null,
            )
        ).json as JsonValue;
        return jsonPath<boolean>("$.added@boolean()", res);
    } catch (e) {
        throw new Error(`Adding words failed\n${errorMessage(e)}`, { cause: e });
    }
}
export async function wordsDel(
    options: Readonly<LTOptions>,
    apiKey: string | null,
    word: string,
): Promise<boolean> {
    if (options.username == null || apiKey == null)
        throw Error(`Syncing words is only supported for premium users`);

    try {
        const res = (
            await requestUrlChecked(
                {
                    url: sUrl(`${options.serverUrl}/v2/words/delete`, {
                        username: options.username,
                        apiKey: apiKey,
                        word,
                    }).href,
                    method: "POST",
                },
                null,
            )
        ).json as JsonValue;
        return jsonPath<boolean>("$.deleted@boolean()", res);
    } catch (e) {
        throw new Error(`Deleting words failed\n${errorMessage(e)}`, { cause: e });
    }
}

export interface SynonymApi {
    name: string;
    url: string;
    query: (sentence: string, selection: { from: number; to: number }) => Promise<string[]>;
}

class SynonymEn implements SynonymApi {
    name = "English";
    url = "https://qb-grammar-en.languagetool.org/phrasal-paraphraser/subscribe";
    async query(sentence: string, selection: { from: number; to: number }): Promise<string[]> {
        const index = sentence.slice(0, selection.from).split(/\s+/).length;
        const word = sentence.slice(selection.from, selection.to);

        const request = {
            message: { indices: [index], mode: 0, phrases: [word], text: sentence },
            meta: {
                clientStatus: "string",
                product: "string",
                traceID: "string",
                userID: "string",
            },
            response_queue: "string",
        };

        try {
            const res = (
                await requestUrlChecked({
                    url: this.url,
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(request),
                })
            ).json as JsonValue;
            return jsonPathA<string>("$.data.suggestions[*][*]@string()", res);
        } catch (e) {
            throw new Error(`Requesting synonyms failed\n${errorMessage(e)}`, { cause: e });
        }
    }
}

class SynonymDe implements SynonymApi {
    name = "Deutsch";
    url = "https://synonyms.languagetool.org/synonyms/de";
    async query(sentence: string, selection: { from: number; to: number }): Promise<string[]> {
        const word = sentence.slice(selection.from, selection.to).trim();
        const before = sentence.slice(0, selection.from).split(/\s+/).join("+");
        const after = sentence.slice(selection.to).split(/\s+/).join("+");

        try {
            const res = (
                await requestUrlChecked({
                    url: sUrl(`${this.url}/${word}`, { before, after }).href,
                    method: "GET",
                })
            ).json as JsonValue;
            return jsonPathA<string>("$.synsets[*].terms[*].term@string()", res);
        } catch (e) {
            throw new Error(`Requesting synonyms failed\n${errorMessage(e)}`, { cause: e });
        }
    }
}

export const SYNONYMS: { [key: string]: SynonymApi } = { en: new SynonymEn(), de: new SynonymDe() };

export class RequestError extends Error {
    constructor(message: string, public readonly retryable: boolean, options?: ErrorOptions) {
        super(message, options);
    }
}

export function isRetryableError(error: unknown): boolean {
    if (error instanceof RequestError) return error.retryable;
    return error instanceof Error && error.cause != null && isRetryableError(error.cause);
}

async function requestUrlChecked(
    request: RequestUrlParam,
    timeout: number | null = 20000,
): Promise<RequestUrlResponse> {
    let response: RequestUrlResponse;
    let timer: number | undefined;
    try {
        const pending = requestUrl({ ...request, throw: false });
        // Mutations must settle before callers can safely send another mutation.
        response = timeout === null
            ? await pending
            : await Promise.race([
                pending,
                new Promise<RequestUrlResponse>((_, reject) => {
                    timer = window.setTimeout(() => reject(new Error("Request timed out")), timeout);
                }),
            ]);
    } catch (e) {
        throw new RequestError(
            `Request to LanguageTool failed: Please check your connection and server URL.\n${errorMessage(e)}`,
            true,
            { cause: e },
        );
    } finally {
        if (timer !== undefined) window.clearTimeout(timer);
    }
    if (response.status === 504 || response.status === 503)
        throw new RequestError(`Request to LanguageTool timed out. Please try again later.`, true);
    if (response.status !== 200) {
        let message = response.text;
        if (message.length > 310) message = message.substring(0, 300) + "...";
        throw new RequestError(
            `Request to LanguageTool failed ${response.status}:\n${message}`,
            response.status === 408 || response.status === 429 || response.status >= 500,
        );
    }
    return response;
}

function jsonPath<T>(path: string, json: JsonValue): T {
    const res = JSONPath<T | null>({ path: path, json: json, wrap: false, eval: false });
    if (res == null) throw new Error(`Error parsing response.`);
    return res;
}
function jsonPathA<T>(path: string, json: JsonValue): T[] {
    const res = JSONPath<T[] | null>({ path: path, json: json, wrap: true, eval: false });
    if (res == null || !(res instanceof Array)) throw new Error(`Error parsing response.`);
    return res;
}

function sUrl(url: string, search: Record<string, string>): URL {
    const u = new URL(url);
    u.search = new URLSearchParams(search).toString();
    return u;
}
