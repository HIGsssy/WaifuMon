/** The production presenter over a clearly simulated, read-only sandbox view. */
import { buildRunScreen } from "./dungeonPresenter";
import type {
  DungeonRunView,
  DungeonEncounterReceipt,
} from "../modules/dungeons/dungeonRunService";
import type { DungeonDefinition } from "../modules/dungeons/content/dungeonDefinition";
import type { DungeonSandbox } from "../modules/dungeons/engine/sandbox";
import type { SpeciesRow, ItemRow } from "../db/schema";
import { DEFAULT_SPRITE_PLACEMENT } from "../modules/artworkAssets/scenePlacement";

export function buildEncounterAuthoringPreview(
  definition: DungeonDefinition,
  sandbox: DungeonSandbox,
  species: SpeciesRow[],
  items: ItemRow[],
  simulatedGrants: Array<{
    species: string;
    copies: number;
    xp: number;
    item: string | null;
    success: boolean;
  }> = [],
) {
  const core = sandbox.view;
  const room = definition.rooms.find((r) => r.id === core.room.id)!;
  const action = room.actions.find((a) => a.id === core.action?.id);
  const none = { assetId: null, artworkPath: null };
  const view: DungeonRunView = {
    id: 0,
    status: sandbox.state.status,
    step: core.step,
    dungeon: {
      key: definition.key,
      name: definition.name,
      description: definition.description,
      revision: 0,
      artwork: none,
      background: none,
    },
    fighter: {
      formulaVersion: 1,
      waifuId: 0,
      speciesSlug: "",
      name: "Simulated Buddy (no capture modifiers)",
      level: 1,
      currentSp: 200,
      attack: 60,
      defense: 30,
      maxHp: 400,
      gear: Object.fromEntries(
        ["attack", "defense", "health"].map((slot) => [
          slot,
          {
            equipmentId: 0,
            definitionKey: "",
            name: "Simulated gear",
            rarity: "N",
            multiplierBp: 10000,
          },
        ]),
      ) as DungeonRunView["fighter"]["gear"],
    },
    core,
    enemy: null,
    roomBackground: none,
    combatEvents: null,
    currency: null,
    defeatRetentionBasisPoints:
      definition.settings.defeatCurrencyRetentionBasisPoints,
    secured: [],
    latestSecured: [],
    settlement: null,
    startedAt: new Date(0),
    completedAt: null,
    latestEncounters: core.recent.flatMap((e) => {
      if (e.kind !== "encounter") return [];
      const authored = definition.rooms
        .find((r) => r.id === e.roomId)
        ?.actions.find((a) => a.id === e.actionId);
      const row = species.find((s) => s.slug === e.species);
      const instance = sandbox.state.encounters?.[`${e.roomId}:${e.actionId}`];
      return [
        {
          roomId: e.roomId,
          actionId: e.actionId,
          type:
            authored?.type === "rescue"
              ? ("rescue" as const)
              : ("wild_encounter" as const),
          species: e.species,
          name: row?.name ?? e.species,
          rarity: row?.rarity ?? null,
          outcome: e.outcome,
          text: e.text,
          unavailableReason: instance?.unavailableReason ?? null,
        },
      ];
    }),
    ...(core.action?.encounter
      ? {
          encounterActor: {
            speciesSlug: core.action.encounter.species,
            placement:
              action && "placement" in action
                ? (action.placement ?? DEFAULT_SPRITE_PLACEMENT)
                : DEFAULT_SPRITE_PLACEMENT,
            mirror: !!(action && "mirror" in action && action.mirror),
          },
        }
      : {}),
  };
  // In-memory presentation data only. The presenter accepts committed-receipt
  // shapes; this adapter never calls a service that could produce a real one.
  const receipts: DungeonEncounterReceipt[] = [];
  const effect = [...sandbox.effects]
    .reverse()
    .find((e) => e.type === "capture_attempt" || e.type === "rescue_grant");
  const grant = simulatedGrants.at(-1);
  if (effect?.type === "capture_attempt")
    receipts.push({
      type: "capture_attempt",
      simulated: false,
      key: effect.key,
      grantKey: effect.grantKey,
      roomId: effect.roomId,
      actionId: effect.actionId,
      species: effect.species,
      mode: effect.mode,
      item: effect.attempt.item,
      attemptNumber: effect.attempt.n,
      success: effect.attempt.success,
      outcome: effect.attempt.success
        ? "success"
        : core.recent.some(
              (e) => e.kind === "encounter" && e.outcome === "escaped",
            )
          ? "escape"
          : "failure",
      guaranteed: effect.guaranteed,
      chance: effect.attempt.chance,
      roll: effect.attempt.roll,
      xpGranted: grant?.xp ?? 0,
      levelUps: [],
      microdose: null,
      acquired: null,
    });
  const payload = buildRunScreen(view, {
    itemName: (slug) => items.find((i) => i.slug === slug)?.name ?? slug,
    encounterReceipts: receipts,
  });
  return {
    simulated: true,
    context:
      "Simulated inventory and Buddy; no capture modifiers, ownership or XP writes. Pool species can be selected for preview. Buttons are display-only.",
    embeds: payload.embeds?.map((e) => ("toJSON" in e ? e.toJSON() : e)) ?? [],
    components:
      payload.components?.map((c) => ("toJSON" in c ? c.toJSON() : c)) ?? [],
  };
}
