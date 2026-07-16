import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
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
import type { CollectionService } from '../modules/collection/collectionService';
import type { ProgressionService } from '../modules/progression/progressionService';

export interface AppServices {
  guilds: GuildService;
  players: PlayerService;
  currency: CurrencyService;
  inventory: InventoryService;
  daily: DailyService;
  shop: ShopService;
  hunt: HuntService;
  capture: CaptureService;
  collection: CollectionService;
  progression: ProgressionService;
}

export interface AppContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  content: LoadedContent;
  services: AppServices;
}

/** Guild + player DB ids resolved after the guard allows the interaction. */
export interface Provisioned {
  guildDbId: number;
  playerId: number;
}

export type PlayerInteraction = ChatInputCommandInteraction | ButtonInteraction;

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
