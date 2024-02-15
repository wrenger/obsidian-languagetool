import * as Remark from 'annotatedtext-remark';
import { Notice } from 'obsidian';
import { getRuleCategories } from './helpers';
import { LanguageToolApi } from './LanguageToolTypings';
import { LanguageToolPluginSettings } from './SettingsTab';

export const logs: string[] = [];

let lastStatus: 'ok' | 'request-failed' | 'request-not-ok' | 'json-parse-error' = 'ok';

export async function getDetectionResult(
	text: string,
	getSettings: () => LanguageToolPluginSettings,
): Promise<LanguageToolApi> {
	const parsedText = Remark.build(text, {
		...Remark.defaults,
		interpretmarkup(text = ''): string {
			// Don't collapse inline code
			if (/^`[^`]+`$/.test(text)) {
				return text;
			}
			const linebreaks = '\n'.repeat(text.match(/\n/g)?.length ?? 0);

			// Support lists (annotation ends with marker)
			if (text.match(/^\s*(-|\d+\.) $/m)) {
				return linebreaks + '• '; // this is the character, the online editor uses
			}

			return linebreaks;
		},
	});
	console.log(parsedText);

	const settings = getSettings();

	const { enabledCategories, disabledCategories } = getRuleCategories(settings);

	const params: { [key: string]: string } = {
		data: JSON.stringify(parsedText),
		language: 'auto',
		enabledOnly: 'false',
		level: settings.pickyMode ? 'picky' : 'default',
	};

	if (enabledCategories.length) {
		params.enabledCategories = enabledCategories.join(',');
	}

	if (disabledCategories.length) {
		params.disabledCategories = disabledCategories.join(',');
	}

	if (settings.ruleOtherRules) {
		params.enabledRules = settings.ruleOtherRules;
	}

	if (settings.ruleOtherDisabledRules) {
		params.disabledRules = settings.ruleOtherDisabledRules;
	}

	if (settings.englishVeriety) {
		params.preferredVariants = `${params.preferredVariants ? `${params.preferredVariants},` : ''}${settings.englishVeriety}`;
	}

	if (settings.germanVeriety) {
		params.preferredVariants = `${params.preferredVariants ? `${params.preferredVariants},` : ''}${settings.germanVeriety}`;
	}

	if (settings.portugueseVeriety) {
		params.preferredVariants = `${params.preferredVariants ? `${params.preferredVariants},` : ''}${settings.portugueseVeriety}`;
	}

	if (settings.catalanVeriety) {
		params.preferredVariants = `${params.preferredVariants ? `${params.preferredVariants},` : ''}${settings.catalanVeriety}`;
	}

	if (settings.apikey && settings.username && settings.apikey.length > 1 && settings.username.length > 1) {
		params.username = settings.username;
		params.apiKey = settings.apikey;
	}

	if (settings.staticLanguage && settings.staticLanguage.length > 0 && settings.staticLanguage !== 'auto') {
		params.language = settings.staticLanguage;
	}

	let res: Response;
	try {
		res = await fetch(`${settings.serverUrl}/v2/check`, {
			method: 'POST',
			body: Object.keys(params)
				.map(key => {
					return `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`;
				})
				.join('&'),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json',
			},
		});
	} catch (e) {
		const status = 'request-failed';
		if (lastStatus !== status || !settings.shouldAutoCheck) {
			new Notice(`Request to LanguageTool server failed. Please check your connection and LanguageTool server URL`, 3000);
			lastStatus = status;
		}
		return Promise.reject(e);
	}

	if (!res.ok) {
		const status = 'request-not-ok';
		await pushLogs(res, settings);
		if (lastStatus !== status || !settings.shouldAutoCheck) {
			new Notice(`Request to LanguageTool failed\n${res.statusText}Check Plugin Settings for Logs`, 3000);
			lastStatus = status;
		}
		return Promise.reject(new Error(`unexpected status ${res.status}, see network tab`));
	}

	let body: LanguageToolApi;
	try {
		body = await res.json();
	} catch (e) {
		const status = 'json-parse-error';
		if (lastStatus !== status || !settings.shouldAutoCheck) {
			new Notice(`Error processing response from LanguageTool server`, 3000);
			lastStatus = status;
		}
		return Promise.reject(e);
	}

	const status = 'ok';
	if (lastStatus !== status || !settings.shouldAutoCheck) {
		new Notice(`LanguageTool detection restored`, 5000);
		lastStatus = status;
	}

	return body;
}

export async function pushLogs(res: Response, settings: LanguageToolPluginSettings): Promise<void> {
	let debugString = `${new Date().toLocaleString()}:
  url used for request: ${res.url}
  Status: ${res.status}
  Body: ${(await res.text()).slice(0, 200)}
  Settings: ${JSON.stringify({ ...settings, username: 'REDACTED', apikey: 'REDACTED' })}
  `;
	if (settings.username || settings.apikey) {
		debugString = debugString
			.replaceAll(settings.username ?? 'username', '<<username>>')
			.replaceAll(settings.apikey ?? 'apiKey', '<<apikey>>');
	}

	logs.push(debugString);

	if (logs.length > 10) {
		logs.shift();
	}
}

export async function synonyms(sentence: string, selection: { from: number; to: number }): Promise<string[]> {
	const URL = "https://qb-grammar-en.languagetool.org/phrasal-paraphraser/subscribe";

	let index = sentence.slice(0, selection.from).split(/\s+/).length;
	let word = sentence.slice(selection.from, selection.to);

	let request = {
		message: {
			indices: [index],
			mode: 0,
			phrases: [word],
			text: sentence
		},
		meta: {
			clientStatus: "string",
			product: "string",
			traceID: "string",
			userID: "string",
		},
		response_queue: "string"
	};

	let res: Response;
	try {
		res = await fetch(URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(request)
		});
	} catch (e) {
		return Promise.reject(e);
	}
	if (!res.ok) {
		return Promise.reject(new Error(`unexpected status ${res.status}`));
	}

	let body: any;
	try {
		body = await res.json();
	} catch (e) {
		return Promise.reject(e);
	}
	if (body.message !== "OK"
		|| body.data == undefined
		|| !(body.data.suggestions instanceof Object)
		|| !(body.data.suggestions[word] instanceof Array)) {
		return Promise.reject(new Error("Invalid response from server"));
	}
	return body.data.suggestions[word] as string[];
}
