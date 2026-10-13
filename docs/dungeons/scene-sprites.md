# Dungeon Scene Sprites

Environmental sprites are visual content for Delve. They have no clicks, animation, state, collision rules or rewards.

## Authoring

Open **Admin — Dungeon Scene Sprites** to create or edit a managed sprite. Choose a unique lower-case identifier, display name, optional Chest/Console/Machinery/Decoration/Other category, artwork, default position, scale, mirror and visual layer. Search the catalogue by name, identifier or category. Include archived sprites to restore them. The editor lists draft and historical revision uses and its audit history. Deletes are refused while any dungeon revision or draft references the sprite; archive it instead.

Catalogue reads require `dungeons.read`; writes require `dungeons.write`. Selecting/previewing catalogue artwork requires the existing `artwork.read`; uploading requires `artwork.write`. Cookie writes use the existing Portal CSRF check. All catalogue mutations record the authenticated actor and revision in `dungeon_scene_sprite_events`; artwork uploads and reference changes use the existing artwork audit trail. A stale catalogue save returns `SCENE_SPRITE_STALE` and never overwrites another author's work.

Artwork uses the shared image storage, picker, validation and upload endpoint, under `dungeon_scene_sprite`. Transparent PNG/WebP is recommended; existing PNG/WebP/JPEG rules and limits still apply. Replacing a sprite's artwork means uploading or selecting another asset in its catalogue editor.

Select a room, then use **Scene Sprites** in the room inspector. Open an activity to place sprites just for that activity. Room and activity placements coexist: five of each, up to ten in a scene, including repeated instances of the same managed sprite. Every added placement copies the current defaults and gets its own instance identifier. Removing the last instance removes the optional field. Saving/reloading retains overrides. Position presets, arrow buttons, scale and offset controls match the existing enemy coordinates and work on narrow screens; a freeform drag canvas is not introduced.

`sceneSprites` is optional, without a default, on rooms and all supported activities. An instance contains `id`, `spriteKey` and optional `placement`, `mirror`, `visualLayer` overrides. APIs may omit overrides to use the catalogue defaults captured at publication. There is no scene sprite field on World Encounters or Buddy content.

## Rendering

The existing `sharp` compositor and render cache are extended. Both Portal previews and Discord use it. The canonical canvas stays 1200×675. Sprites use the existing six anchors, 1000–10000 scale basis points (height as a percentage of the canvas), X offsets −600…600 and Y offsets −337…337. Width follows the source aspect ratio; rectangles are clamped inside the canvas. Mirroring happens inside the rectangle, retaining alpha edges.

Order: scene background, background environmental sprites, the reserved player Buddy, enemy sprite, foreground environmental sprites. Within each environmental layer, room instances draw first and activity instances afterwards in author order. Discord text and controls remain outside the image. The renderer appends environmental settings to the cache identity only when there are placements, preserving earlier enemy/Buddy cache keys and pixels for sprite-free scenes. Missing/undecodable environmental images are omitted under a separate cache key, retaining other sprites. A missing background falls through to the existing plain stage.

Presentation limitations are explicit:

- Non-combat activities show environmental sprites without Buddy or enemy actors.
- Events without sprites still show their standalone image unchanged. Events with placements compose that image as the 16:9 backdrop using the existing cover crop. Specific-event activity previews use that event's artwork. Random-pool authoring previews use the room background because the live draw is not known until the run chooses it.
- An enemy without a usable combat sprite retains its opaque full-art fallback without a Buddy. Environmental layers can be composed over that flattened picture; they cannot be inserted behind a character already painted into it. Upload a transparent enemy sprite for true actor-layer control.
- Activity previews show the first combat wave (the first pool candidate for a random wave); other waves keep their respective enemy images and use the same environmental placements at runtime.

## Publication and dependencies

Existing definition hashes and sprite-free package bytes are preserved: no new defaults are added to dungeon content. Migration 0067 adds nullable `dungeon_revisions.scene_sprite_snapshot`. A publish freezes the referenced catalogue keys, names, artwork IDs/hashes/categories and defaults into that existing immutable revision, with a checked visual hash. The content retains each instance's explicit overrides. Republishing captures a changed catalogue visual even if the definition content hash is unchanged; `sceneSpritesDiffer` reports this to Portal authors. Active and new runs of an earlier publication resolve from its frozen snapshot. Rollback validates and reuses the chosen revision's own visuals, even if the catalogue sprite is now archived.

The current artwork store removes replaced bytes and has no historical-version storage. To preserve published scene sprites without a second storage/retention model, assets frozen in **any** dungeon revision are protected against replacement, disabling, category moves and deletion. The shared artwork API reports `ARTWORK_ASSET_IN_USE` with revision references. Upload a new image and select that on the catalogue sprite; earlier revisions retain the old asset, including rollback targets with no active run. Renaming the asset is allowed. This protection also applies when the image is shared with another content type. Existing enemy/Buddy/background artwork behavior is otherwise unchanged.

Validation checks instance uniqueness, counts, placement bounds/scale/layer, catalogue existence/archive status and active stored artwork. Publication rejects broken visual dependencies; draft saves permit unresolved catalogue references for repair. Validation paths locate the room and activity so the Portal's **Show me** opens the affected inspector/activity. The shared dependency walker includes scene sprite keys, and includes their artwork when given the catalogue visual index. Runtime image loss still degrades gracefully.

## Packages

Package v1/v2/v3 meanings are unchanged. Sprite-free and event-free exports follow their existing paths. Dungeons containing room/activity placements are explicitly gated at service export, pure package construction, inspection and import (`package_scene_sprites_unsupported`). No incomplete package is produced or applied, and destination catalogues are never overwritten. Ordinary draft saves and publication are supported locally.

Follow-up portability work needs an explicit new package version with a frozen sprite-definition/artwork manifest, destination missing/conflict decisions, explicit permission for any replacement, and the existing disabled/unpublished import lifecycle. Until that workflow is designed, exports with placements remain blocked. This release does not introduce a new package version.

## Migration and staging verification

Created migrations: `0066_dungeon_scene_sprites.sql` (shared artwork category, catalogue and audit tables) and `0067_dungeon_scene_sprite_snapshots.sql` (nullable revision visual snapshot). They are registered after Phase 3's 0065. They were exercised only in disposable local test databases. No staging/production migration is applied by this task.

Before staging deployment, rehearse the 0066 artwork category CHECK replacement and the 0067 revision-table alteration against representative table sizes with a bounded lock timeout. Back up database and managed artwork together. Upgrade database, backend/bot, then Portal. Keep a roll-forward option for any newly authored content that older strict dungeon schemas cannot read.

Verify with a delegated author and reader, plus an ordinary player: create/upload/search/edit/archive, denied writes/CSRF, room plus activity placements, repeated instances, narrow-screen controls, save/reload and Show me. Preview and play combat/boss/treasure/rest/specific Event/pool Event; check foreground/background, scale, mirroring and the documented full-art/Event cropping limits. Publish, edit the catalogue, start another run, republish while a run is active, archive and roll back. Confirm frozen-image replace/disable/delete/category changes are refused with references. Remove a physical sprite file in a disposable staging fixture to confirm graceful omission. Check sprite-bearing export/import refusal and ordinary v1/v2/v3 packages.
