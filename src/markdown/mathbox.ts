import type { Plugin } from 'unified';
import type { Root, Element, RootContent } from 'hast';

const isDisplayMath = (node: RootContent): node is Element =>
    node.type == 'element' &&
    node.tagName == 'div' &&
    Array.isArray(node.properties?.className) &&
    node.properties.className.includes('math-display');

// A display equation is one unbreakable box: on a narrow screen it either
// overflows the page or gets clipped. Wrapping it in a scroll container lets the
// equation slide sideways on its own while the prose around it stays put.
const wrap = (math: Element): Element => ({
    type: 'element',
    tagName: 'div',
    properties: { className: ['math-scroll-container'] },
    children: [
        {
            type: 'element',
            tagName: 'div',
            properties: { className: ['math-container'] },
            children: [math],
        },
    ],
});

export const rehypeMathBox: Plugin<[], Root> = () => {
    return (tree) => {
        const stack: Array<Root | Element> = [tree];
        while (stack.length > 0) {
            const children = stack.pop()!.children;
            for (let i = 0; i < children.length; i++) {
                const child = children[i]!;
                if (child.type != 'element') continue;
                // The wrapper is not descended into: it still contains the
                // display-math node, and revisiting it would wrap it again,
                // forever.
                if (isDisplayMath(child)) children[i] = wrap(child);
                else stack.push(child);
            }
        }
    };
};
