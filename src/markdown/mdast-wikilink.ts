import { CompileContext, Extension, Token } from "mdast-util-from-markdown";
import { Node, Parent } from "mdast";
import { Fragment } from "mdast-util-from-markdown/lib/types";

declare module 'mdast' {
    interface RootContentMap {
        wikiLink: WikiLink,
    }
}

interface WikiLink extends Parent {
    type: 'wikiLink';
    data?: {
        value?: string | undefined;
        link?: string | undefined;
    }
}

export function wikiLinkFromMarkdown(opts: {} = {}): Extension {
    const resolveLink = (name: string) => name.replace(/ /g, '_').toLowerCase();
    let node: WikiLink;

    function enterWikiLink(this: CompileContext, token: Token): void {
        node = {
            type: 'wikiLink',
            children: [],
        };
        this.enter(node, token);
    }

    function top(stack: (Fragment | Node)[]): WikiLink {
        let node = stack.at(-1);
        if (node && node.type === 'wikiLink')
            return node as WikiLink;
        throw new Error('Expected wikiLink node');
    }

    function exitWikiLinkTarget(this: CompileContext, token: Token) {
        const target = this.sliceSerialize(token);
        const current = top(this.stack);
        current.data = {
            value: target,
            link: resolveLink(target),
        };
        current.children = [{
            type: 'text',
            value: target,
            position: {
                start: token.start,
                end: token.end,
            },
        }];
    }

    function exitWikiLinkAlias(this: CompileContext, token: Token) {
        const alias = this.sliceSerialize(token);
        const current = top(this.stack);
        current.data!!.value = alias;
        current.children = [{
            type: 'text',
            value: alias,
            position: {
                start: token.start,
                end: token.end,
            },
        }]
    }

    function exitWikiLink(this: CompileContext, token: Token) {
        this.exit(token);
    }

    return {
        enter: {
            wikiLink: enterWikiLink
        },
        exit: {
            wikiLinkTarget: exitWikiLinkTarget,
            wikiLinkAlias: exitWikiLinkAlias,
            wikiLink: exitWikiLink
        }
    };
}
