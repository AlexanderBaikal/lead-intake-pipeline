import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getProvider } from "../src/llm/index.js";
import type { ExtractedLead } from "../src/schema.js";

/**
 * Regression harness for the extraction step.
 *
 * The point is not a score — it is that changing the prompt, the model, or the
 * fallback parser stops being a blind edit. Every case is a real message shape
 * the pipeline has to survive; `note` says which one, so a failure names the
 * behaviour that broke instead of just a number going down.
 *
 * `npm run eval` runs against whatever LLM_PROVIDER is configured: the
 * deterministic parser in CI (no key needed), the live model locally.
 */

const OVERALL_THRESHOLD = 0.9;
const PER_CASE_FLOOR = 0.5;

/** Free text; scored by a human reading it, not by this harness. */
const UNSCORED = new Set(["notes"]);

interface Case {
  id: string;
  note: string;
  reference_date: string;
  text: string;
  expect: Partial<Record<keyof ExtractedLead, unknown>>;
}

const here = dirname(fileURLToPath(import.meta.url));
const cases: Case[] = JSON.parse(await readFile(join(here, "cases.json"), "utf8"));

const equal = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const a = [...actual].map(String).sort();
    const b = [...expected].map(String).sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return actual === expected;
};

const provider = getProvider();
let scored = 0;
let correct = 0;
const perField = new Map<string, { hit: number; total: number }>();
const failures: string[] = [];

for (const testCase of cases) {
  const { lead } = await provider.extract({
    text: testCase.text,
    contactHint: null,
    referenceDate: new Date(`${testCase.reference_date}T12:00:00Z`),
  });

  const misses: string[] = [];
  let caseScored = 0;
  let caseCorrect = 0;

  for (const [field, expected] of Object.entries(testCase.expect)) {
    if (UNSCORED.has(field)) continue;
    const actual = (lead as Record<string, unknown>)[field];
    const ok = equal(actual, expected);

    caseScored += 1;
    scored += 1;
    if (ok) {
      caseCorrect += 1;
      correct += 1;
    } else {
      misses.push(
        `${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }

    const stat = perField.get(field) ?? { hit: 0, total: 0 };
    stat.total += 1;
    if (ok) stat.hit += 1;
    perField.set(field, stat);
  }

  const ratio = caseScored === 0 ? 1 : caseCorrect / caseScored;
  const mark = misses.length === 0 ? "ok  " : ratio < PER_CASE_FLOOR ? "FAIL" : "warn";
  console.log(`${mark} ${testCase.id.padEnd(24)} ${caseCorrect}/${caseScored}`);
  for (const miss of misses) console.log(`       ${miss}`);
  if (ratio < PER_CASE_FLOOR) {
    failures.push(
      `${testCase.id} scored ${caseCorrect}/${caseScored} — ${testCase.note}`,
    );
  }
}

const accuracy = scored === 0 ? 0 : correct / scored;

console.log("\nper field:");
for (const [field, stat] of [...perField].sort()) {
  console.log(`  ${field.padEnd(16)} ${stat.hit}/${stat.total}`);
}

console.log(`\nprovider=${provider.name} model=${provider.model ?? "-"}`);
console.log(
  `accuracy ${correct}/${scored} = ${(accuracy * 100).toFixed(1)}% (threshold ${(OVERALL_THRESHOLD * 100).toFixed(0)}%)`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} case(s) below the per-case floor:`);
  for (const failure of failures) console.error(`  ${failure}`);
}

if (accuracy < OVERALL_THRESHOLD || failures.length > 0) {
  process.exitCode = 1;
}
