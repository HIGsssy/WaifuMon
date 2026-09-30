/**
 * Chain relationships between World Encounters, derived from the encounters
 * themselves — pure, no React, no requests.
 *
 * The engine has no "chain" table. A chain is whatever the stored encounters
 * say, read exactly the way `resolveChoice` reads it:
 *
 *   - A choice outcome continues to another encounter through a
 *     `trigger_encounter` effect in its success (or failure) effects.
 *   - An encounter may also carry `chainedEncounterSlug`, which is appended
 *     *after* the outcome's own effects — so it only fires for an outcome
 *     that has no `trigger_encounter` of its own ("after any choice").
 *   - Only the **first** follow-up of a resolution is used; later ones in the
 *     same outcome are ignored.
 *   - An automatic (no-check) choice always succeeds, so its failure effects —
 *     follow-ups included — never run.
 *   - A link back to the same encounter is skipped.
 *   - A follow-up opens only while its lifecycle is `active`; a draft,
 *     disabled or missing follow-up ends the chain at the parent.
 *   - Otherwise it opens without a chance roll, and without checking its
 *     sources, regions or repeat cooldown.
 *
 * Everything here reports those facts; nothing decides behaviour.
 */

export interface GraphChoice {
  label: string;
  check: Record<string, unknown>;
  successEffects: ReadonlyArray<Record<string, unknown>>;
  failureEffects: ReadonlyArray<Record<string, unknown>>;
}

/** The fields the graph reads — satisfied by `AdminEncounter` and the editor draft. */
export interface GraphEncounter {
  id?: number;
  slug: string;
  name: string;
  lifecycle: string;
  huntEligible: boolean;
  travelEligible: boolean;
  chainedEncounterSlug: string | null;
  choices: ReadonlyArray<GraphChoice>;
}

/**
 * Which result leads on.
 *
 *   `success` / `failure` — a skill-check choice's branch.
 *   `outcome` — an automatic choice (it has only one result).
 *   `after_any` — the encounter-level `chainedEncounterSlug`.
 */
export type LinkBranch = 'success' | 'failure' | 'outcome' | 'after_any';

export interface ChainLink {
  from: string;
  to: string;
  choiceIndex: number | null;
  choiceLabel: string | null;
  branch: LinkBranch;
  /** False when the engine will never follow this link. */
  live: boolean;
  /**
   * Why a link is not live:
   *   `shadowed` — an earlier follow-up in the same outcome wins;
   *   `failure_never_runs` — failure effects of an automatic choice;
   *   `self` — links back to its own encounter, which the engine skips.
   */
  deadReason?: 'shadowed' | 'failure_never_runs' | 'self';
}

export type RoleKind = 'standalone' | 'root' | 'child' | 'chain-only';

export interface EncounterRole {
  /** Can appear on its own from Hunt or Travel. */
  spawns: boolean;
  /** Distinct slugs of encounters that link here (any link, as the server counts reachability). */
  parents: string[];
  /** Distinct slugs this encounter links to, existing or not. */
  children: string[];
  primary: RoleKind;
}

export interface GraphIssue {
  /** `error`: broken content. `warning`: probably unintended, but runs. */
  severity: 'error' | 'warning';
  code:
    | 'orphan'
    | 'missing_target'
    | 'inactive_target'
    | 'also_spawns'
    | 'cycle'
    | 'shadowed'
    | 'failure_never_runs'
    | 'self';
  slug: string;
  message: string;
  target?: string;
  /** For a loop: every encounter on it. */
  members?: string[];
}

export interface EncounterGraph {
  encounters: ReadonlyMap<string, GraphEncounter>;
  outgoing: ReadonlyMap<string, ChainLink[]>;
  incoming: ReadonlyMap<string, ChainLink[]>;
  roleOf(slug: string): EncounterRole;
  issues: GraphIssue[];
  issuesFor(slug: string): GraphIssue[];
}

function triggerTargets(effects: ReadonlyArray<Record<string, unknown>>): string[] {
  return effects
    .filter((e) => e.type === 'trigger_encounter')
    .map((e) => (typeof e.encounterSlug === 'string' ? e.encounterSlug : ''));
}

/** Every chain link one encounter declares, live or not, in authoring order. */
export function linksOf(encounter: GraphEncounter): ChainLink[] {
  const links: ChainLink[] = [];
  let someOutcomeHasNoFollowUp = false;

  encounter.choices.forEach((choice, choiceIndex) => {
    const auto = choice.check.type === 'none';
    const outcomes: Array<{ branch: LinkBranch; effects: GraphChoice['successEffects'] }> = [
      { branch: auto ? 'outcome' : 'success', effects: choice.successEffects },
      { branch: 'failure', effects: choice.failureEffects },
    ];
    for (const { branch, effects } of outcomes) {
      const targets = triggerTargets(effects);
      const runs = !(auto && branch === 'failure');
      if (runs && targets.length === 0) someOutcomeHasNoFollowUp = true;
      targets.forEach((to, i) => {
        if (!to) return; // unfinished picker — reported by draft validation
        const link: ChainLink = {
          from: encounter.slug,
          to,
          choiceIndex,
          choiceLabel: choice.label,
          branch,
          live: true,
        };
        if (!runs) Object.assign(link, { live: false, deadReason: 'failure_never_runs' });
        else if (i > 0) Object.assign(link, { live: false, deadReason: 'shadowed' });
        else if (to === encounter.slug) Object.assign(link, { live: false, deadReason: 'self' });
        links.push(link);
      });
    }
  });

  if (encounter.chainedEncounterSlug) {
    const to = encounter.chainedEncounterSlug;
    const link: ChainLink = {
      from: encounter.slug,
      to,
      choiceIndex: null,
      choiceLabel: null,
      branch: 'after_any',
      live: true,
    };
    if (to === encounter.slug) Object.assign(link, { live: false, deadReason: 'self' });
    else if (!someOutcomeHasNoFollowUp)
      Object.assign(link, { live: false, deadReason: 'shadowed' });
    links.push(link);
  }
  return links;
}

const unique = (values: string[]): string[] => Array.from(new Set(values));

export function buildEncounterGraph(list: ReadonlyArray<GraphEncounter>): EncounterGraph {
  const encounters = new Map<string, GraphEncounter>();
  for (const e of list) encounters.set(e.slug, e);

  const outgoing = new Map<string, ChainLink[]>();
  const incoming = new Map<string, ChainLink[]>();
  for (const e of encounters.values()) {
    const links = linksOf(e);
    outgoing.set(e.slug, links);
    for (const link of links) {
      const into = incoming.get(link.to) ?? [];
      into.push(link);
      incoming.set(link.to, into);
    }
  }

  const roleOf = (slug: string): EncounterRole => {
    const e = encounters.get(slug);
    const spawns = e ? e.huntEligible || e.travelEligible : false;
    // Self-links are not parents: the engine skips them, and the server's
    // reachability check would be the only one to count them.
    const parents = unique((incoming.get(slug) ?? []).map((l) => l.from).filter((f) => f !== slug));
    const children = unique((outgoing.get(slug) ?? []).map((l) => l.to).filter((t) => t !== slug));
    const primary: RoleKind = !spawns
      ? 'chain-only'
      : parents.length > 0
        ? 'child'
        : children.length > 0
          ? 'root'
          : 'standalone';
    return { spawns, parents, children, primary };
  };

  const issues: GraphIssue[] = [];
  for (const e of encounters.values()) {
    const role = roleOf(e.slug);
    if (!role.spawns && role.parents.length === 0) {
      issues.push({
        severity: 'error',
        code: 'orphan',
        slug: e.slug,
        message: `“${e.name}” is chain-only, but nothing links to it — it can never appear.`,
      });
    }
    if (role.spawns && role.parents.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'also_spawns',
        slug: e.slug,
        message: `“${e.name}” is a chain follow-up but also appears on its own in ${sourcesOf(e)}.`,
      });
    }
    for (const link of outgoing.get(e.slug) ?? []) {
      const target = encounters.get(link.to);
      const where = describeLinkOrigin(link);
      if (link.deadReason === 'self') {
        issues.push({
          severity: 'error',
          code: 'self',
          slug: e.slug,
          target: link.to,
          message: `“${e.name}” ${where} links back to itself; the engine skips it.`,
        });
        continue;
      }
      if (link.deadReason === 'shadowed') {
        issues.push({
          severity: 'warning',
          code: 'shadowed',
          slug: e.slug,
          target: link.to,
          message:
            link.branch === 'after_any'
              ? `“${e.name}”: the “after any choice” follow-up never runs — every outcome has its own.`
              : `“${e.name}” ${where} has more than one follow-up; only the first is used.`,
        });
      }
      if (link.deadReason === 'failure_never_runs') {
        issues.push({
          severity: 'warning',
          code: 'failure_never_runs',
          slug: e.slug,
          target: link.to,
          message: `“${e.name}” ${where}: automatic choices always succeed, so this failure follow-up never runs.`,
        });
      }
      if (!target) {
        issues.push({
          severity: 'error',
          code: 'missing_target',
          slug: e.slug,
          target: link.to,
          message: `“${e.name}” ${where} continues to “${link.to}”, which does not exist — players get no follow-up.`,
        });
      } else if (link.live && target.lifecycle !== 'active') {
        issues.push({
          severity: 'warning',
          code: 'inactive_target',
          slug: e.slug,
          target: link.to,
          message:
            `“${e.name}” ${where} continues to “${target.name}”, which is ${target.lifecycle}. ` +
            'Follow-ups only open while Active, so the chain ends here until it is activated.',
        });
      }
    }
  }
  for (const cycle of findCycles(encounters, outgoing)) {
    const names = cycle.map((s) => encounters.get(s)?.name ?? s);
    issues.push({
      severity: 'warning',
      code: 'cycle',
      slug: cycle[0]!,
      members: cycle,
      message: `Loop: ${[...names, names[0]].join(' → ')}. Allowed, but players can go round forever.`,
    });
  }

  const issuesFor = (slug: string) =>
    issues.filter((i) => i.slug === slug || (i.members?.includes(slug) ?? false));

  return { encounters, outgoing, incoming, roleOf, issues, issuesFor };
}

function sourcesOf(e: GraphEncounter): string {
  return [e.huntEligible && 'Hunt', e.travelEligible && 'Travel'].filter(Boolean).join(' and ');
}

export const BRANCH_LABEL: Record<LinkBranch, string> = {
  success: 'On success',
  failure: 'On failure',
  outcome: 'Outcome',
  after_any: 'After any choice',
};

/** "(choice “Open it”, on success)" — where a link is authored, for messages. */
export function describeLinkOrigin(link: ChainLink): string {
  if (link.branch === 'after_any') return '(after any choice)';
  const branch = link.branch === 'outcome' ? '' : `, on ${link.branch}`;
  return `(choice “${link.choiceLabel ?? `#${(link.choiceIndex ?? 0) + 1}`}”${branch})`;
}

/** Simple cycles over live links, each reported once (rotation-normalised). */
function findCycles(
  encounters: ReadonlyMap<string, GraphEncounter>,
  outgoing: ReadonlyMap<string, ChainLink[]>,
): string[][] {
  const seen = new Set<string>();
  const cycles: string[][] = [];
  const visit = (slug: string, path: string[]) => {
    for (const link of outgoing.get(slug) ?? []) {
      if (!link.live || !encounters.has(link.to)) continue;
      const at = path.indexOf(link.to);
      if (at >= 0) {
        const cycle = path.slice(at);
        const start = cycle.indexOf([...cycle].sort()[0]!);
        const normalised = [...cycle.slice(start), ...cycle.slice(0, start)];
        const key = normalised.join('>');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(normalised);
        }
        continue;
      }
      if (path.length < 50) visit(link.to, [...path, link.to]);
    }
  };
  for (const slug of encounters.keys()) visit(slug, [slug]);
  return cycles;
}

/* ─────────────────────── Chain tree (Chains view) ─────────────────────── */

export interface ChainBranch {
  link: ChainLink;
  node: ChainNode;
}

export interface ChainChoiceNode {
  index: number;
  label: string;
  auto: boolean;
  branches: ChainBranch[];
}

export interface ChainNode {
  slug: string;
  encounter: GraphEncounter | null;
  /** Already shown higher up this path — the view stops here. */
  repeat: boolean;
  choices: ChainChoiceNode[];
  afterAny: ChainBranch | null;
}

/**
 * The chain below `slug`, choice by choice. Choices with no follow-up are left
 * out; an encounter already on the current path is shown once more as a
 * `repeat` leaf, so a loop terminates.
 */
export function buildChainTree(
  graph: EncounterGraph,
  slug: string,
  path: ReadonlySet<string> = new Set(),
): ChainNode {
  const encounter = graph.encounters.get(slug) ?? null;
  if (!encounter || path.has(slug)) {
    return { slug, encounter, repeat: encounter != null, choices: [], afterAny: null };
  }
  const nextPath = new Set(path).add(slug);
  const links = graph.outgoing.get(slug) ?? [];
  const branchOf = (link: ChainLink): ChainBranch => ({
    link,
    node:
      link.deadReason === 'self'
        ? { slug: link.to, encounter, repeat: true, choices: [], afterAny: null }
        : buildChainTree(graph, link.to, nextPath),
  });

  const choices: ChainChoiceNode[] = encounter.choices
    .map((choice, index) => ({
      index,
      label: choice.label,
      auto: choice.check.type === 'none',
      branches: links.filter((l) => l.choiceIndex === index).map(branchOf),
    }))
    .filter((c) => c.branches.length > 0);
  const after = links.find((l) => l.branch === 'after_any');
  return { slug, encounter, repeat: false, choices, afterAny: after ? branchOf(after) : null };
}

/**
 * Where to start drawing chains: every encounter with follow-ups that nothing
 * links to, then — for loops with no entry point — one member of each
 * remaining linked component.
 */
export function chainRoots(graph: EncounterGraph): string[] {
  const roots: string[] = [];
  const covered = new Set<string>();
  const cover = (slug: string) => {
    if (covered.has(slug)) return;
    covered.add(slug);
    for (const link of graph.outgoing.get(slug) ?? []) cover(link.to);
  };
  const slugs = Array.from(graph.encounters.keys()).sort((a, b) =>
    (graph.encounters.get(a)!.name ?? a).localeCompare(graph.encounters.get(b)!.name ?? b),
  );
  for (const slug of slugs) {
    const role = graph.roleOf(slug);
    if (role.children.length > 0 && role.parents.length === 0) {
      roots.push(slug);
      cover(slug);
    }
  }
  for (const slug of slugs) {
    const role = graph.roleOf(slug);
    if (!covered.has(slug) && role.children.length > 0) {
      roots.push(slug);
      cover(slug);
    }
  }
  return roots;
}
