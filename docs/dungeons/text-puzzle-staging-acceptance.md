# Text Input Puzzle — staging acceptance checklist

For the operator signing off the `text_puzzle` dungeon activity on staging. It needs a staging bot and Portal built from a commit that includes `0c826b7`, a staging Discord server, **two** Discord test accounts, and Portal access with `dungeons.write` and `dungeons.publish`.

No database migration is involved: puzzle progress is stored in the existing run row.

## Already verified automatically (no staging needed)

These ran locally against real Postgres, the real Discord handlers (with test doubles for the Discord objects), the real engine and validator, and a production Portal build in Chromium:

- Matching: `0042` accepts `0042` and rejects `42`, `00042`, `9999`. Capitals are ignored unless the author asks otherwise; spaces before and after are trimmed unless the author asks otherwise; inner spaces and punctuation always count.
- Unlimited attempts by default; limited attempts count down; the last wrong answer follows the configured "exhausted" route (default: carry on unsolved).
- Attempts survive a restart of the run service and a retreat; a solved or exhausted puzzle is never asked again and its effects are never applied twice.
- Duplicate, simultaneous, stale, other-player and post-abandon/completion/extraction submissions are refused and change nothing.
- No accepted answer or typed guess appears in a Discord screen, button or form id, run row, run log or player view.
- Draft save, validation, publish, republish, rollback, export/import and the sandbox carry every puzzle setting unchanged; runs keep the revision they started on.
- Existing dungeons hash exactly as before.

What follows can only be confirmed on staging: real Discord rendering and modal behaviour, a real bot restart, and real accounts.

## 1. Build the keypad dungeon in the Portal

1. **Admin → Dungeons → New dungeon.** Name it `Keypad Test`, tick a region your test accounts can play in.
2. Rename the start room **Break Room**. Set its description to `Someone scratched 0042 into the table.`
3. Add a next room **Security Terminal**, then from it a next room **Vault** made an **Exit**. Add a path from Security Terminal back to Break Room.
4. Select **Security Terminal → More → Text Input Puzzle**:
   - Puzzle title `Security Terminal`, Prompt `ENTER ACCESS CODE`.
   - Accepted answer 1: `0042`. Leave capitals unticked and "Ignore spaces before and after" ticked.
   - Attempts allowed: leave empty (unlimited).
   - Correct message `ACCESS GRANTED`, wrong message `ACCESS DENIED`.
   - **When solved, remember → New…** and call it `Security door unlocked`.
5. Select the Security Terminal → Vault path, make it a **Locked path** that opens when **Security door unlocked has happened**. Locked text: `The vault door is sealed.`
6. **Save draft**. Reload the page and reopen the puzzle: every value above is still there.
7. Checklist shows **Nothing to fix**. **Play the dungeon** (dungeon settings → Events → Play the dungeon): enter `42` (❌ Incorrect — ACCESS DENIED), then `0042` (✅ Solved — ACCESS GRANTED, "Remembers: Security door unlocked").
8. **Publish**.

☐ Pass ☐ Fail — notes:

## 2. Wrong and right answers on Discord (account A)

1. `/waifumon` → **Delve** → start **Keypad Test**. The Break Room shows the clue; go to **Security Terminal**.
2. The screen shows 🧩 **Security Terminal**, `ENTER ACCESS CODE`, an **Enter Answer** button and **Abandon**. There is **no** button to the Vault or back to the Break Room.
3. **Enter Answer** opens a form titled *Enter Answer* with one field, *Your answer*. Submit `42`.
   - The same message updates in place with **❌ Incorrect — ACCESS DENIED**. No new message appears. Enter Answer is still offered.
4. Submit `9999`: Incorrect again.
5. Submit ` 0042 ` (with spaces): **✅ Solved — ACCESS GRANTED**. The room shows the way to the Vault **unlocked**.
6. Take it: the run completes.

☐ Pass ☐ Fail — notes:

## 3. Stale and foreign submissions

1. Account A: start a new run and reach the terminal (screen **X**). Run `/waifumon` → **Delve** again to get a second screen of the same run (screen **Y**).
2. On **Y**, submit a wrong answer.
3. On the older screen **X**, press **Enter Answer** and submit `0042`: the reply says *"That button is from an earlier moment — here's where you are."* and the puzzle is **still unsolved**, with the attempt count from step 2.
4. Get a fresh screen, abandon the run, then use **Enter Answer** on any earlier screen and submit `0042`: the same stale notice; nothing is granted and the run stays abandoned.
4. Account B cannot see account A's ephemeral screen, so a cross-account submission cannot be performed through the client. This is covered by automated tests only.

☐ Pass ☐ Fail — notes:

## 4. Attempts survive a bot restart

1. Edit the puzzle: **Attempts allowed 3**, **Message when attempts run out** `LOCKOUT`. Publish.
2. Account A: new run, reach the terminal, submit one wrong answer. The screen shows **2 attempts left**.
3. Restart the staging bot process (operator action).
4. `/waifumon` → **Delve** → Resume. The puzzle still shows **2 attempts left**. Submit two more wrong answers.
   - The last shows **🔒 Out of attempts — LOCKOUT**.
   - The room finishes **unsolved**: the Vault path stays **locked** ("The vault door is sealed.") and the way back to the Break Room is offered.
5. Return to the Security Terminal: the puzzle is **not** asked again and the Vault stays locked.

☐ Pass ☐ Fail — notes:

## 5. Exhausted and optional behaviour is what the editor says

1. In the editor, open the puzzle's **Advanced options**. **After the last attempt is used up** reads *Usual: continue with the next activity, unsolved*.
2. Tick **Players can choose to skip this**, publish, start a new run: a **Skip** button now sits beside **Enter Answer**. Skipping leaves the Vault locked.
3. Untick it again before continuing.

Authoring note: if the only ways out of the puzzle's room need the solved flag, exhausting a limited puzzle leaves the player with only **Abandon**. The screen shows the existing "There is no way forward from here" warning; this is the same as any other unopenable lock. Give the room another way out, or route **After the last attempt is used up** somewhere deliberate.

☐ Pass ☐ Fail — notes:

## 6. Answers are never shown to players

On every Discord screen from sections 2–4, confirm `0042` appears **nowhere**: not in the message text, embed, field names, button labels or the form. Developer Mode → right-click a button → Copy ID also shows only `wm|v1|dg|pz|<run id>|<step>`.

Also check the bot logs from the session: neither `0042` nor any typed guess (`42`, `9999`) appears.

☐ Pass ☐ Fail — notes:

## 7. Existing dungeons are unaffected

1. In the Portal, open an existing published dungeon with no puzzle. It shows **Nothing to fix** (or exactly the issues it had before) and has no unsaved changes.
2. Account B: play that dungeon through at least one fight, treasure and room change. Everything behaves as before.
3. Export it. The package's `contentHash` matches the one from before this release (compare with a previous export if one is kept).

☐ Pass ☐ Fail — notes:

## Sign-off

| Section | Result | By | Date |
| --- | --- | --- | --- |
| 1 Portal authoring | | | |
| 2 Wrong/right answers | | | |
| 3 Stale submissions | | | |
| 4 Restart persistence | | | |
| 5 Exhausted/optional | | | |
| 6 Answer secrecy | | | |
| 7 Existing dungeons | | | |
