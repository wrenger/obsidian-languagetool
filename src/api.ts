import { endpointFromUrl, LTOptions } from "./settings";
import { RequestUrlParam, RequestUrlResponse, requestUrl } from "obsidian";
import { JSONPath } from "jsonpath-plus";
import { AnnotatedText } from "./annotated";

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
    settings: Readonly<LTOptions>,
    offset: number,
    annotated: AnnotatedText,
): Promise<LTLint[]> {
    const data = annotated.stringify();

    const lang = settings.staticLanguage || "auto";
    const params: { [key: string]: string } = {
        data,
        language: lang,
        enabledOnly: "false",
        level: settings.pickyMode ? "picky" : "default",
    };

    if (settings.motherTongue) params.motherTongue = settings.motherTongue;

    if (settings.enabledCategories.length)
        params.enabledCategories = settings.enabledCategories.join(",");
    if (settings.disabledCategories.length)
        params.disabledCategories = settings.disabledCategories.join(",");

    if (settings.enabledRules.length) params.enabledRules = settings.enabledRules.join(",");
    if (settings.disabledRules.length) params.disabledRules = settings.disabledRules.join(",");

    if (lang == "auto")
        params.preferredVariants = Object.values(settings.languageVariety).join(",");

    const endpointType = endpointFromUrl(settings.serverUrl);
    if (endpointType !== "public" && settings.apikey && settings.username) {
        params.username = settings.username;
        params.apiKey = settings.apikey;
    }

    const res = await requestUrlChecked({
        url: `${settings.serverUrl}/v2/check`,
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

export async function languages(serverUrl: string): Promise<Language[]> {
    const languages = (await requestUrl({ url: `${serverUrl}/v2/languages` }).json) as JsonValue;
    if (languages == null || !(languages instanceof Array))
        throw new Error(`Error processing response from LanguageTool.`);
    // @ts-expect-error, not typed
    return languages as Language[];
}

export async function words(settings: Readonly<LTOptions>): Promise<string[]> {
    if (settings.username == null || settings.apikey == null)
        throw Error(`Syncing words is only supported for premium users`);

    try {
        const res = (
            await requestUrlChecked({
                url: sUrl(`${settings.serverUrl}/v2/words`, {
                    username: settings.username,
                    apiKey: settings.apikey,
                    limit: "1000",
                }).href,
            })
        ).json as JsonValue;
        return jsonPathA<string>("$.words[*]@string()", res);
    } catch (e) {
        throw new Error(`Requesting words failed\n${e}`);
    }
}
export async function wordsAdd(settings: Readonly<LTOptions>, word: string): Promise<boolean> {
    if (settings.username == null || settings.apikey == null)
        throw Error(`Syncing words is only supported for premium users`);

    try {
        const res = (
            await requestUrlChecked({
                url: sUrl(`${settings.serverUrl}/v2/words/add`, {
                    username: settings.username,
                    apiKey: settings.apikey,
                    word,
                }).href,
                method: "POST",
            })
        ).json as JsonValue;
        return jsonPath<boolean>("$.added@boolean()", res);
    } catch (e) {
        throw new Error(`Adding words failed\n${e}`);
    }
}
export async function wordsDel(settings: Readonly<LTOptions>, word: string): Promise<boolean> {
    if (settings.username == null || settings.apikey == null)
        throw Error(`Syncing words is only supported for premium users`);

    try {
        const res = (
            await requestUrlChecked({
                url: sUrl(`${settings.serverUrl}/v2/words/delete`, {
                    username: settings.username,
                    apiKey: settings.apikey,
                    word,
                }).href,
                method: "POST",
            })
        ).json as JsonValue;
        return jsonPath<boolean>("$.deleted@boolean()", res);
    } catch (e) {
        throw new Error(`Deleting words failed\n${e}`);
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
            throw new Error(`Requesting synonyms failed\n${e}`);
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
            throw new Error(`Requesting synonyms failed\n${e}`);
        }
    }
}

export const SYNONYMS: { [key: string]: SynonymApi } = { en: new SynonymEn(), de: new SynonymDe() };

async function requestUrlChecked(request: RequestUrlParam): Promise<RequestUrlResponse> {
    let response: RequestUrlResponse;
    try {
        response = await requestUrl({ ...request, throw: false });
    } catch (e) {
        throw new Error(
            `Request to LanguageTool failed: Please check your connection and server URL.\n${e}`,
        );
    }
    if (response.status === 504 || response.status === 503)
        throw new Error(`Request to LanguageTool timed out. Please try again later.`);
    if (response.status !== 200) {
        let message = response.text;
        if (message.length > 310) message = message.substring(0, 300) + "...";
        throw new Error(`Request to LanguageTool failed ${response.status}:\n${message}`);
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
