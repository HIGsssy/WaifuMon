/**
 * Shared vocabulary for admin account adjustments.
 *
 * Every admin tool that changes a player's account — `/waifumon-admin player`
 * in Discord and the Portal's Staging Test Controls — records one row in
 * `player_progression_events` with this `event_type`. The row's `metadata`
 * carries the specifics (`action`, the acting admin, before/after), so one
 * query answers "what did admins do to this account?" regardless of which
 * surface they used.
 */
export const ADMIN_ACTION_EVENT = 'admin_player_action';
