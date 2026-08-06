/**
 * axe-core harness for the component suite (plan §21 Phase 3, §17).
 *
 * Runs the real WCAG 2 A/AA rule set over rendered markup. jsdom cannot compute
 * layout, so a handful of rules are disabled below — each with a reason, and
 * each covered instead by the Playwright pass, which runs axe in a real browser
 * where geometry and computed colour exist.
 *
 * A violation is reported with its rule id, impact and the offending markup, so
 * a failure is actionable without opening a browser.
 */
import axe, { type AxeResults, type Result, type RunOptions } from 'axe-core';

/**
 * Rules jsdom cannot evaluate honestly.
 *
 * `color-contrast` is the important one: it needs computed styles from real CSS,
 * and the Portal's palette lives in Tailwind-generated stylesheets that jsdom
 * never loads (`css: false` in the Vitest config). Contrast is therefore
 * asserted in the Playwright suite, against the real build.
 */
const JSDOM_UNSUPPORTED: Record<string, { enabled: false }> = {
  'color-contrast': { enabled: false },
  'target-size': { enabled: false },
  'scrollable-region-focusable': { enabled: false },
};

const OPTIONS: RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  rules: JSDOM_UNSUPPORTED,
};

function describe(violations: Result[]): string {
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .slice(0, 3)
        .map((node) => `      ${node.html}`)
        .join('\n');
      return `  [${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help}\n${nodes}`;
    })
    .join('\n\n');
}

export async function runAxe(container: HTMLElement = document.body): Promise<AxeResults> {
  return axe.run(container, OPTIONS);
}

/** Asserts the container is free of WCAG A/AA violations axe can detect. */
export async function expectNoAxeViolations(container: HTMLElement = document.body): Promise<void> {
  const results = await runAxe(container);
  if (results.violations.length > 0) {
    throw new Error(
      `Found ${results.violations.length} accessibility violation(s):\n\n${describe(results.violations)}`,
    );
  }
}
