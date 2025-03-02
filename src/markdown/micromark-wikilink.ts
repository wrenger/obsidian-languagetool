
import { Code, Effects, Extension, State } from 'micromark-util-types';

declare module 'micromark-util-types' {
    interface TokenTypeMap {
        wikiLink: 'wikiLink',
        wikiLinkMarker: 'wikiLinkMarker',
        wikiLinkData: 'wikiLinkData',
        wikiLinkTarget: 'wikiLinkTarget',
        wikiLinkAliasMarker: 'wikiLinkAliasMarker',
        wikiLinkAlias: 'wikiLinkAlias',
    }
}

const codes = {
    horizontalTab: -2,
    virtualSpace: -1,
    nul: 0,
    eof: null,
    space: 32,
    leftSquareBracket: 91, // `[`
}

function markdownLineEndingOrSpace(code: Code) {
    return code != null && (code < codes.nul || code === codes.space)
}

function markdownLineEnding(code: Code) {
    return code != null && (code < codes.horizontalTab)
}

interface Options {
    aliasDivider?: string
}

export function wikiLink(opts: Options = {}): Extension {
    const aliasDivider = opts.aliasDivider || '|'

    const aliasMarker = aliasDivider
    const startMarker = '[['
    const endMarker = ']]'

    function tokenize(effects: Effects, ok: State, nok: State) {
        var data = false;
        var alias = false;

        var aliasCursor = 0;
        var startMarkerCursor = 0;
        var endMarkerCursor = 0;

        return start;

        function start(code: Code) {
            if (code !== startMarker.charCodeAt(startMarkerCursor))
                return nok(code);

            effects.enter('wikiLink');
            effects.enter('wikiLinkMarker');

            return consumeStart(code);
        }

        function consumeStart(code: Code) {
            if (startMarkerCursor === startMarker.length) {
                effects.exit('wikiLinkMarker');
                return consumeData(code);
            }

            if (code !== startMarker.charCodeAt(startMarkerCursor)) {
                return nok(code);
            }

            effects.consume(code);
            startMarkerCursor++;

            return consumeStart;
        }

        function consumeData(code: Code) {
            if (markdownLineEnding(code) || code === codes.eof) {
                return nok(code);
            }

            effects.enter('wikiLinkData');
            effects.enter('wikiLinkTarget');
            return consumeTarget(code);
        }

        function consumeTarget(code: Code) {
            if (code === aliasMarker.charCodeAt(aliasCursor)) {
                if (!data) return nok(code);
                effects.exit('wikiLinkTarget');
                effects.enter('wikiLinkAliasMarker');
                return consumeAliasMarker(code);
            }

            if (code === endMarker.charCodeAt(endMarkerCursor)) {
                if (!data) return nok(code);
                effects.exit('wikiLinkTarget');
                effects.exit('wikiLinkData');
                effects.enter('wikiLinkMarker');
                return consumeEnd(code);
            }

            if (markdownLineEnding(code) || code === codes.eof) {
                return nok(code);
            }

            if (!markdownLineEndingOrSpace(code)) {
                data = true;
            }

            effects.consume(code);

            return consumeTarget;
        }

        function consumeAliasMarker(code: Code) {
            if (aliasCursor === aliasMarker.length) {
                effects.exit('wikiLinkAliasMarker');
                effects.enter('wikiLinkAlias');
                return consumeAlias(code);
            }

            if (code !== aliasMarker.charCodeAt(aliasCursor)) {
                return nok(code);
            }

            effects.consume(code);
            aliasCursor++;

            return consumeAliasMarker;
        }

        function consumeAlias(code: Code) {
            if (code === endMarker.charCodeAt(endMarkerCursor)) {
                if (!alias) return nok(code);
                effects.exit('wikiLinkAlias');
                effects.exit('wikiLinkData');
                effects.enter('wikiLinkMarker');
                return consumeEnd(code);
            }

            if (markdownLineEnding(code) || code === codes.eof) {
                return nok(code);
            }

            if (!markdownLineEndingOrSpace(code)) {
                alias = true;
            }

            effects.consume(code);

            return consumeAlias;
        }

        function consumeEnd(code: Code) {
            if (endMarkerCursor === endMarker.length) {
                effects.exit('wikiLinkMarker');
                effects.exit('wikiLink');
                return ok(code);
            }

            if (code !== endMarker.charCodeAt(endMarkerCursor)) {
                return nok(code);
            }

            effects.consume(code);
            endMarkerCursor++;

            return consumeEnd;
        }
    }
    return {
        text: {
            [codes.leftSquareBracket]: {
                name: 'wikilink',
                tokenize: tokenize
            }
        }
    };
}
