/**
 * Minimal helpers over `fast-xml-parser`'s `preserveOrder` trees.
 *
 * Structural mutation, never string substitution: a card carries
 * author-supplied text, and `String.replace` over an SVG document is the exact
 * shape of bug that turns a subtitle containing `</text>` into a broken (or
 * hostile) document. Everything here works on parsed nodes, and text only ever
 * enters through {@link setTextContent}, which escapes.
 *
 * Node shape, for reference:
 * ```
 * { "text": [ { "#text": "CHARACTER NAME" } ], ":@": { "@_id": "character-name" } }
 * ```
 */
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { escapeXml } from '../text';

export const ATTRS_KEY = ':@';
export const TEXT_KEY = '#text';
export const ATTR_PREFIX = '@_';

export type XmlNode = Record<string, unknown>;
export type XmlTree = XmlNode[];

/**
 * `processEntities: false` on both sides so the source document's existing
 * entities round-trip untouched and escaping happens in exactly one place
 * ({@link setTextContent}).
 */
const SHARED_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  processEntities: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
} as const;

const parser = new XMLParser(SHARED_OPTIONS);
const builder = new XMLBuilder({ ...SHARED_OPTIONS, suppressEmptyNode: true, format: false });

export function parseXml(xml: string): XmlTree {
  return parser.parse(xml) as XmlTree;
}

export function buildXml(tree: XmlTree): string {
  return builder.build(tree) as string;
}

/** The element name of a node, or `null` for a text node. */
export function tagNameOf(node: XmlNode): string | null {
  for (const key of Object.keys(node)) {
    if (key === ATTRS_KEY) continue;
    return key === TEXT_KEY ? null : key;
  }
  return null;
}

/** Child list of an element node, or `null` if it is a text node. */
export function childrenOf(node: XmlNode): XmlTree | null {
  const tag = tagNameOf(node);
  if (tag === null) return null;
  const children = node[tag];
  return Array.isArray(children) ? (children as XmlTree) : null;
}

export function attrsOf(node: XmlNode): Record<string, string> | undefined {
  return node[ATTRS_KEY] as Record<string, string> | undefined;
}

export function getAttr(node: XmlNode, name: string): string | undefined {
  return attrsOf(node)?.[`${ATTR_PREFIX}${name}`];
}

export function setAttr(node: XmlNode, name: string, value: string | number): void {
  const attrs = (node[ATTRS_KEY] as Record<string, string> | undefined) ?? {};
  attrs[`${ATTR_PREFIX}${name}`] = String(value);
  node[ATTRS_KEY] = attrs;
}

export interface FoundNode {
  node: XmlNode;
  /** The array the node lives in, so it can be removed in place. */
  siblings: XmlTree;
  index: number;
}

/** Depth-first search for the first element carrying `id`. */
export function findById(tree: XmlTree, id: string): FoundNode | null {
  for (let index = 0; index < tree.length; index += 1) {
    const node = tree[index];
    if (!node) continue;
    if (getAttr(node, 'id') === id) return { node, siblings: tree, index };
    const children = childrenOf(node);
    if (children) {
      const found = findById(children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Every element with the given tag name, in document order. */
export function findAllByTag(tree: XmlTree, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const node of tree) {
    if (!node) continue;
    if (tagNameOf(node) === tag) out.push(node);
    const children = childrenOf(node);
    if (children) out.push(...findAllByTag(children, tag));
  }
  return out;
}

/**
 * Replaces an element's children with a single escaped text node. This is the
 * only door user-authored text uses to get into the document.
 */
export function setTextContent(node: XmlNode, text: string): void {
  const tag = tagNameOf(node);
  if (tag === null) return;
  node[tag] = [{ [TEXT_KEY]: escapeXml(text) }];
}

/** Removes the first element with `id`. Returns whether anything was removed. */
export function removeById(tree: XmlTree, id: string): boolean {
  const found = findById(tree, id);
  if (!found) return false;
  found.siblings.splice(found.index, 1);
  return true;
}

/** Appends nodes to an element's child list. */
export function appendChildren(node: XmlNode, children: XmlTree): void {
  const tag = tagNameOf(node);
  if (tag === null) return;
  const existing = childrenOf(node) ?? [];
  node[tag] = [...existing, ...children];
}

/**
 * The drawable children of a standalone icon SVG — i.e. everything inside its
 * root `<svg>`. Lifting the children (rather than nesting the whole document)
 * lets the destination group's `color` drive the icon's `currentColor`.
 */
export function svgRootChildren(xml: string): XmlTree {
  const tree = parseXml(xml);
  for (const node of tree) {
    if (tagNameOf(node) === 'svg') return childrenOf(node) ?? [];
  }
  return [];
}
