import { tooltips } from '@codemirror/view';
import LanguageToolPlugin from 'src/main';
import { buildAutoCheckHandler } from './buildAutoCheckHandler';
import { buildTooltipField } from './tooltipField';
import { underlineField } from './underlineField';

export function buildUnderlineExtension(plugin: LanguageToolPlugin) {
	return [
		tooltips({
			position: 'absolute',
			tooltipSpace: view => view.dom.getBoundingClientRect(),
		}),
		underlineField,
		buildTooltipField(plugin),
		buildAutoCheckHandler(plugin),
	];
}
