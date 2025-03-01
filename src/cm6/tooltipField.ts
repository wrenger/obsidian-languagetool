import { EditorView, Tooltip, showTooltip } from '@codemirror/view';
import { StateField, EditorState } from '@codemirror/state';
import { categoryCssClass } from '../helpers';
import { setIcon } from 'obsidian';
import { default as LanguageToolPlugin, SUGGESTIONS } from 'src/main';
import { clearUnderlinesInRange, underlineField, clearMatchingUnderlines } from './underlineField';
import { api } from "src/api";

function constructTooltip(plugin: LanguageToolPlugin, view: EditorView, underline: api.LTMatch): HTMLDivElement {
	const buttons = underline.replacements.slice(0, SUGGESTIONS);
	const category = underline.categoryId;
	const ruleId = underline.ruleId;

	return createDiv({ cls: ['lt-predictions-container', categoryCssClass(category)] }, root => {
		if (underline.title) {
			root.createSpan({ cls: 'lt-title' }, span => {
				span.createSpan({ text: underline.title });
			});
		}

		if (underline.message) {
			root.createSpan({ cls: 'lt-message', text: underline.message });
		}

		root.createDiv({ cls: 'lt-bottom' }, bottom => {
			if (buttons.length > 0) {
				bottom.createDiv({ cls: 'lt-buttoncontainer' }, container => {
					for (const btnText of buttons) {
						container.createEl('button', { text: btnText || "(delete)" }, button => {
							button.onclick = () => view.dispatch({
								changes: [{
									from: underline.from,
									to: underline.to,
									insert: btnText,
								}],
								effects: [(clearUnderlinesInRange.of(underline))],
							});
						});
					}
				});
			}
			bottom.createDiv({ cls: 'lt-info-container' }, container => {
				container.createEl('button', { cls: 'lt-info-button clickable-icon' }, button => {
					setIcon(button, 'info');
					button.onclick = () => {
						const popup = document.getElementsByClassName('lt-info-box').item(0);
						if (popup)
							popup.toggleAttribute('hidden');
					};
				});

				container.createDiv({ cls: 'lt-info-box', attr: { 'hidden': true } }, popup => {
					// \u00A0 is a non-breaking space
					popup.createDiv({ cls: 'lt-info', text: `Category:\u00A0${category}` });
					popup.createDiv({ cls: 'lt-info', text: `Rule:\u00A0${ruleId}` });
				});
			});
		});

		root.createDiv({ cls: 'lt-ignorecontainer' }, container => {
			if (category === 'TYPOS') {
				container.createEl('button', { cls: 'lt-ignore-btn' }, button => {
					setIcon(button.createSpan(), 'plus-with-circle');
					button.createSpan({ text: 'Add to personal dictionary' });
					button.onclick = async () => {
						// Add to global dictionary
						plugin.settings.dictionary.push(underline.text);
						await plugin.syncDictionary();

						// Remove other underlines with the same word
						view.dispatch({
							effects: [clearMatchingUnderlines.of(match => match.text === underline.text)],
						});
					};
				});
			} else {
				container.createEl('button', { cls: 'lt-ignore-btn' }, button => {
					setIcon(button.createSpan(), 'cross');
					button.createSpan({ text: 'Ignore suggestion' });
					button.onclick = () => view.dispatch({ effects: [(clearUnderlinesInRange.of(underline))] });
				});
				if (category !== 'SYNONYMS') {
					container.createEl('button', { cls: 'lt-ignore-btn' }, button => {
						setIcon(button.createSpan(), 'circle-off');
						button.createSpan({ text: 'Disable rule' });
						button.onclick = () => {
							if (plugin.settings.disabledRules)
								plugin.settings.disabledRules += ',' + ruleId;
							else plugin.settings.disabledRules = ruleId;
							plugin.saveSettings();

							// Remove other underlines of the same rule
							view.dispatch({
								effects: [clearMatchingUnderlines.of(match => match.ruleId === ruleId)],
							});
						};
					});
				}
			}
		});
	});
}

function getTooltip(tooltips: readonly Tooltip[], plugin: LanguageToolPlugin, state: EditorState): readonly Tooltip[] {
	const underlines = state.field(underlineField);

	if (underlines.size === 0 || state.selection.ranges.length > 1) {
		return [];
	}

	let primaryUnderline: api.LTMatch | null = null;

	underlines.between(state.selection.main.from, state.selection.main.to, (from, to, value) => {
		primaryUnderline = { ...value.spec.underline as api.LTMatch, from, to };
	});

	if (primaryUnderline != null) {
		const { from, to } = primaryUnderline;

		if (tooltips.length) {
			const tooltip = tooltips[0];

			if (tooltip.pos === from && tooltip.end === to) {
				return tooltips;
			}
		}

		return [{
			pos: from,
			end: to,
			above: true,
			strictSide: false,
			arrow: false,
			create: view => {
				return { dom: constructTooltip(plugin, view, primaryUnderline as api.LTMatch) };
			},
		}];
	}

	return [];
}

export function buildTooltipField(plugin: LanguageToolPlugin): StateField<readonly Tooltip[]> {
	return StateField.define<readonly Tooltip[]>({
		create: state => getTooltip([], plugin, state),
		update: (tooltips, tr) => getTooltip(tooltips, plugin, tr.state),
		provide: f => showTooltip.computeN([f], state => state.field(f)),
	});
}
