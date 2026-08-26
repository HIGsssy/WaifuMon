import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { AppConfig } from '../config/config';
import type { Db } from '../db/client';
import type { Logger } from '../shared/logger';
import type { LoadedContent } from '../modules/content/schemas';
import type { GuildService } from '../modules/guilds/guildService';
import type { PlayerService } from '../modules/players/playerService';
import type { CurrencyService } from '../modules/currency/currencyService';
import type { InventoryService } from '../modules/inventory/inventoryService';
import type { DailyService } from '../modules/daily/dailyService';
import type { ShopService } from '../modules/shop/shopService';
import type { HuntService } from '../modules/hunt/huntService';
import type { CaptureService } from '../modules/capture/captureService';
import type { CareService } from '../modules/care/careService';
import type { CollectionService } from '../modules/collection/collectionService';
import type { AppearanceService } from '../modules/appearance/appearanceService';
import type { PlayerEffectsService } from '../modules/effects/playerEffectsService';
import type { ItemUseService } from '../modules/items/itemUseService';
import type { ProgressionService } from '../modules/progression/progressionService';
import type { QuestService } from '../modules/quests/questService';
import type { SessionService } from '../modules/session/sessionService';
import type { GameEventBus } from '../modules/events/gameEvents';
import type { HuntSessionTracker } from '../modules/hunt/huntSession';
import type { CollectionFilterTracker } from './collectionFilterTracker';
import type { EphemeralRegistry } from './ephemeralCleanup';
import type { OwnedCardWarmer } from '../modules/appearance/ownedCardWarm';

export interface AppServices {
  guilds: GuildService;
  players: PlayerService;
  currency: CurrencyService;
  inventory: InventoryService;
  daily: DailyService;
  shop: ShopService;
  hunt: HuntService;
  capture: CaptureService;
  care: CareService;
  collection: CollectionService;
  /**
   * Cosmetic appearance gallery, selection, and unlock bookkeeping. Reads
   * waifu level; writes only `variant` and `seen_appearances`.
   */
  appearance: AppearanceService;
  progression: ProgressionService;
  quests: QuestService;
  session: SessionService;
  /** Active consumable buffs (Microdose charges). */
  effects: PlayerEffectsService;
  /** "Use" an inventory consumable (Energy Drink, Microdose). */
  itemUse: ItemUseService;
}

export interface AppContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  /**
   * In-memory content snapshot. Republished by the admin panel's Reload
   * Content action, so handlers must read `ctx.content` at call time rather
   * than destructuring it once at wiring time.
   */
  content: LoadedContent;
  services: AppServices;
  /**
   * Central gameplay-event bus. Handlers emit onto it **after** their
   * transaction commits; the Activity Feed and Trainer Profile subscribe.
   * Subscribers can never fail a gameplay write (see `emitEvents`).
   */
  events: GameEventBus;
  /**
   * In-memory hunt-session bookkeeping (which players are "out hunting", and
   * in which flavor location). Cosmetic only — nothing gameplay-relevant
   * depends on it, and a restart just re-opens sessions.
   */
  huntSessions: HuntSessionTracker;
  /**
   * Filter/sort/page state for the grouped collection browser. Pure view
   * state, never gameplay state — see `discord/collectionFilterTracker.ts`.
   *
   * Optional: when absent the collection screen lazily attaches a tracker of
   * its own scoped to this context, so tests that build a bare `AppContext`
   * still get correct (and mutually isolated) filter behaviour.
   */
  collectionFilters?: CollectionFilterTracker | undefined;
  /**
   * Tracked ephemeral interaction responses, per player, so Care Mode can
   * sweep the clutter it replaces. In-memory and best-effort — see
   * `discord/ephemeralCleanup.ts` for what Discord actually permits here.
   *
   * Optional for the same reason as `collectionFilters`: a context without one
   * gets a lazily-attached registry of its own.
   */
  ephemerals?: EphemeralRegistry | undefined;
  /**
   * Background warming of owned card derivatives.
   *
   * Present only when card rendering is switched on, and never load-bearing: a
   * capture must succeed identically whether or not anything is warming behind
   * it. See `modules/appearance/ownedCardWarm.ts`.
   */
  cardWarmer?: OwnedCardWarmer | undefined;
}

/** Guild + player DB ids resolved after the guard allows the interaction. */
export interface Provisioned {
  guildDbId: number;
  playerId: number;
}

export type PlayerInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

export type CommandHandler = (
  ctx: AppContext,
  interaction: PlayerInteraction,
  provisioned: Provisioned,
) => Promise<void>;

/** Custom ID scheme: wm|v1|<scope>|<action>|<...args> (plan §19). */
export const CUSTOM_ID_PREFIX = 'wm';
export const CUSTOM_ID_VERSION = 'v1';

export interface ParsedCustomId {
  scope: string;
  action: string;
  args: string[];
}

export function buildCustomId(scope: string, action: string, ...args: string[]): string {
  return [CUSTOM_ID_PREFIX, CUSTOM_ID_VERSION, scope, action, ...args].join('|');
}

/**
 * Returns null for foreign custom ids (not ours) and 'unknown_version' for a
 * wm id from a different schema version.
 */
export function parseCustomId(customId: string): ParsedCustomId | 'unknown_version' | null {
  const parts = customId.split('|');
  if (parts[0] !== CUSTOM_ID_PREFIX) return null;
  if (parts[1] !== CUSTOM_ID_VERSION) return 'unknown_version';
  const [, , scope, action, ...args] = parts;
  if (!scope || !action) return null;
  return { scope, action, args };
}
