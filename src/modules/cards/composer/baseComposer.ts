/**
 * Layer 1 of the pipeline: turn `templates/card-base.svg` plus one card's data
 * into a self-contained SVG document ready for resvg.
 *
 * Scope note — the rarity overlay is deliberately **not** touched here. Rarity
 * SVGs carry their own `rarityStroke`/`glow` gradient and filter ids, which
 * would collide the moment two of them (or one of them and the base) shared a
 * document. Keeping rarity a separate rasterized layer means any future rarity
 * file can use whatever internal ids it likes, forever.
 */
import type { Affinity } from '../../../db/schema';
import { AFFINITY_DESCRIPTIONS, affinityLabel } from '../affinity';
import { CardTemplateError } from '../errors';
import { raceLabel, type RaceCode } from '../race';
import {
  cleanOptional,
  fitText,
  normalizeWhitespace,
  TEXT_LIMITS,
  truncate,
  wrapToTwoLines,
} from '../text';
import type { SpeciesCardMeta } from '../types';
import { ARTWORK_HREF } from './artworkHref';
import {
  appendChildren,
  buildXml,
  findAllByTag,
  findById,
  getAttr,
  parseXml,
  removeById,
  setAttr,
  setTextContent,
  svgRootChildren,
  tagNameOf,
  type XmlTree,
} from './xmlTree';

/**
 * Usable widths measured off the template geometry, minus a little breathing
 * room. Changing any of these changes pixels — bump `CARD_RENDERER_VERSION`.
 */
const LAYOUT = {
  /** Name panel is x=220 w=600. */
  nameMaxWidth: 560,
  nameTiers: [54, 44, 36] as const,
  subtitleMaxWidth: 560,
  subtitleFontSize: 22,
  /** Race pill is 140 wide. */
  raceLabelMaxWidth: 128,
  raceLabelFontSize: 18,
  /** Affinity label starts at absolute x=150; the description starts at 430. */
  affinityLabelMaxWidth: 265,
  affinityLabelFontSize: 24,
  /** Description runs x=430 to the panel edge at 942. */
  affinityDescMaxWidth: 496,
  affinityDescFontSize: 20,
  /** Ability text runs x=155 to the panel edge at 942. */
  abilityMaxWidth: 770,
  abilityNameFontSize: 27,
  abilityTextFontSize: 19,
  /** Flavor quote is centred on x=500. */
  flavorMaxWidth: 860,
  flavorFontSize: 21,
  /**
   * The credit row is inset to x 190…810 so it clears the rarity overlays'
   * corner flourishes, and split around the centred WAIFUMON wordmark (which
   * occupies roughly x 440…560 at its 22px size).
   */
  artistMaxWidth: 240,
  artistFontSize: 16,
  cardNumberMaxWidth: 230,
  cardNumberFontSize: 16,
} as const;

/** Icon `currentColor` per slot: race sits on a light disc, affinity on a dark one. */
const RACE_ICON_COLOR = '#111111';
const AFFINITY_ICON_COLOR = '#f5f5f5';

export interface ComposeBaseSvgInput {
  baseSvg: string;
  raceIconSvg: string;
  affinityIconSvg: string;
  name: string;
  race: RaceCode;
  affinity: Affinity;
  level: number;
  card: SpeciesCardMeta;
}

export interface ComposedBaseSvg {
  svg: string;
  /** The `href` values resvg will ask us to resolve — exactly one, the artwork. */
  imageHrefs: string[];
}

/**
 * Builds the base SVG for one card. Every optional field that is absent or
 * blank has its element removed outright rather than rendered empty, so a card
 * with no metadata reads as a clean card and not as a card with holes in it.
 */
export function composeBaseSvg(input: ComposeBaseSvgInput): ComposedBaseSvg {
  const tree = parseXml(input.baseSvg);

  const artNode = findById(tree, 'character-art');
  if (!artNode) {
    throw new CardTemplateError('Base template has no element with id "character-art"');
  }
  if (tagNameOf(artNode.node) !== 'image') {
    throw new CardTemplateError('Base template\'s "character-art" element is not an <image>');
  }
  // The template ships a relative placeholder href for browser preview; the
  // renderer swaps in its sentinel so resvg hands the node back to us to fill.
  setAttr(artNode.node, 'href', ARTWORK_HREF);

  setFittedText(tree, 'character-name', truncate(normalizeWhitespace(input.name), TEXT_LIMITS.characterName), {
    maxWidth: LAYOUT.nameMaxWidth,
    tiers: LAYOUT.nameTiers,
    bold: true,
  });

  setOrRemove(tree, 'character-subtitle', cleanOptional(input.card.subtitle, TEXT_LIMITS.subtitle), {
    maxWidth: LAYOUT.subtitleMaxWidth,
    fontSize: LAYOUT.subtitleFontSize,
  });

  setText(tree, 'level', String(Math.trunc(input.level)));

  injectIcon(tree, 'race-icon', input.raceIconSvg, RACE_ICON_COLOR);
  setOrRemove(tree, 'race-label', raceLabel(input.race), {
    maxWidth: LAYOUT.raceLabelMaxWidth,
    fontSize: LAYOUT.raceLabelFontSize,
    bold: true,
  });

  injectIcon(tree, 'affinity-icon', input.affinityIconSvg, AFFINITY_ICON_COLOR);
  setOrRemove(tree, 'affinity-label', affinityLabel(input.affinity), {
    maxWidth: LAYOUT.affinityLabelMaxWidth,
    fontSize: LAYOUT.affinityLabelFontSize,
    bold: true,
  });

  const [affinityLine1, affinityLine2] = wrapToTwoLines(
    AFFINITY_DESCRIPTIONS[input.affinity],
    LAYOUT.affinityDescMaxWidth,
    LAYOUT.affinityDescFontSize,
  );
  setOrRemoveRaw(tree, 'affinity-description', affinityLine1);
  setOrRemoveRaw(tree, 'affinity-description-2', affinityLine2);

  applyAbility(tree, input.card);

  setOrRemove(tree, 'flavor-quote', quote(cleanOptional(input.card.flavorQuote, TEXT_LIMITS.flavorQuote)), {
    maxWidth: LAYOUT.flavorMaxWidth,
    fontSize: LAYOUT.flavorFontSize,
  });

  const artist = cleanOptional(input.card.artist, TEXT_LIMITS.artist);
  setOrRemove(tree, 'artist-credit', artist === null ? null : `Artist - ${artist}`, {
    maxWidth: LAYOUT.artistMaxWidth,
    fontSize: LAYOUT.artistFontSize,
  });

  setOrRemove(tree, 'card-number', cleanOptional(input.card.cardNumber, TEXT_LIMITS.cardNumber), {
    maxWidth: LAYOUT.cardNumberMaxWidth,
    fontSize: LAYOUT.cardNumberFontSize,
  });

  const svg = buildXml(tree);
  return { svg, imageHrefs: collectImageHrefs(tree) };
}

function collectImageHrefs(tree: XmlTree): string[] {
  const hrefs = new Set<string>([ARTWORK_HREF]);
  for (const image of findAllByTag(tree, 'image')) {
    const value = getAttr(image, 'href') ?? getAttr(image, 'xlink:href');
    if (value) hrefs.add(value);
  }
  return [...hrefs];
}

/** Ability is all-or-nothing: without both fields the whole panel is removed. */
function applyAbility(tree: XmlTree, card: SpeciesCardMeta): void {
  const name = cleanOptional(card.ability?.name, TEXT_LIMITS.abilityName);
  const text = cleanOptional(card.ability?.text, TEXT_LIMITS.abilityText);
  if (name === null || text === null) {
    removeById(tree, 'ability-block');
    return;
  }

  setFittedText(tree, 'ability-name', name, {
    maxWidth: LAYOUT.abilityMaxWidth,
    tiers: [LAYOUT.abilityNameFontSize],
    bold: true,
  });

  const [line1, line2] = wrapToTwoLines(text, LAYOUT.abilityMaxWidth, LAYOUT.abilityTextFontSize);
  setOrRemoveRaw(tree, 'ability-text', line1);
  setOrRemoveRaw(tree, 'ability-text-2', line2);
}

function quote(value: string | null): string | null {
  return value === null ? null : `“${value}”`;
}

interface SingleSizeOptions {
  maxWidth: number;
  fontSize: number;
  bold?: boolean;
}

interface FitOptions {
  maxWidth: number;
  tiers: readonly number[];
  bold?: boolean;
}

/** Sets text verbatim (already-wrapped lines); removes the element when blank. */
function setOrRemoveRaw(tree: XmlTree, id: string, value: string): void {
  if (value.length === 0) {
    removeById(tree, id);
    return;
  }
  setText(tree, id, value);
}

/** Sets text, shrinking or truncating to fit; removes the element when null. */
function setOrRemove(
  tree: XmlTree,
  id: string,
  value: string | null,
  options: SingleSizeOptions,
): void {
  if (value === null || value.length === 0) {
    removeById(tree, id);
    return;
  }
  setFittedText(tree, id, value, {
    maxWidth: options.maxWidth,
    tiers: [options.fontSize],
    ...(options.bold === undefined ? {} : { bold: options.bold }),
  });
}

function setFittedText(tree: XmlTree, id: string, value: string, options: FitOptions): void {
  const found = findById(tree, id);
  if (!found) return;
  const fitted = fitText(value, options.maxWidth, options.tiers, options.bold ?? false);
  setTextContent(found.node, fitted.text);
  setAttr(found.node, 'font-size', fitted.fontSize);
}

function setText(tree: XmlTree, id: string, value: string): void {
  const found = findById(tree, id);
  if (!found) return;
  setTextContent(found.node, value);
}

/**
 * Lifts an icon SVG's children into the placeholder group and sets `color` so
 * the icon's `currentColor` strokes/fills pick up the right value for the disc
 * they sit on.
 */
function injectIcon(tree: XmlTree, id: string, iconSvg: string, color: string): void {
  const found = findById(tree, id);
  if (!found) {
    throw new CardTemplateError(`Base template has no icon slot with id "${id}"`);
  }
  const children = svgRootChildren(iconSvg);
  if (children.length === 0) {
    throw new CardTemplateError(`Icon for slot "${id}" has no drawable content`);
  }
  appendChildren(found.node, children);
  setAttr(found.node, 'color', color);
}
