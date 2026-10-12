// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * **An issue from outside the team arrives on a form, and the form marks it for triage** (#707).
 *
 * The board's `Inbox` holds every idea nobody has refined yet, ours included. `needs-triage` is what
 * separates the ones filed on a form: each issue form applies it, and `/refine` creates our own issues
 * with `--body-file`, which skips the forms. So the label is only as good as the set of forms that carry
 * it. A template added without it files issues nobody is told to evaluate, and turning blank issues back
 * on lets a reporter skip the forms on the web. Both fail silently, so this gate holds them:
 *
 * 1. **Every issue form applies `needs-triage`, and sets an issue type.** What kind of issue it is goes in
 *    the type, never a label: one per issue, so nothing is both a bug and a feature. Labels are for what
 *    can overlap, so a form that applies `bug`, `enhancement` or `documentation` fails here.
 * 2. **Blank issues are off, and the only contact link a reporter sees is private disclosure.**
 * 3. **The pull request template asks for the issue it closes**, by a keyword GitHub acts on.
 * 4. **`SECURITY.md` names the same private advisory link.**
 *
 * **What this cannot hold is an issue filed through the API.** `blank_issues_enabled` governs the web
 * chooser only, so `gh issue create` or a POST to the issues endpoint files with no form and no label.
 * Labeling by `author_association` would need an `issues: opened` workflow, which #707 left out.
 *
 * The files are read as text. There is no YAML parser in this monorepo (`mcp/yaml.ts` says why), and each
 * form keeps `type:` and `labels:` on one line each on purpose, so a line read is the whole read.
 */

/** The repository root. This file lives at `packages/cli/src/ci/`. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

const TEMPLATES = resolve(REPO_ROOT, ".github", "ISSUE_TEMPLATE");
const PR_TEMPLATE = resolve(REPO_ROOT, ".github", "pull_request_template.md");
const SECURITY = resolve(REPO_ROOT, "SECURITY.md");

const TRIAGE_LABEL = "needs-triage";
/** The issue types the `pithy-sh` org defines: `gh api orgs/pithy-sh/issue-types`. A form naming any other fails to file. */
const ISSUE_TYPES = ["Bug", "Feature", "Task", "Epic"];

/** The labels that once said what kind of issue it was. The issue type says that now. */
const KIND_LABELS = ["bug", "enhancement", "documentation"];

const ADVISORY_URL = "https://github.com/pithy-sh/pithy/security/advisories/new";

/** The labels a form applies, from its one-line `labels: [a, "b"]`. `undefined` when it has none. */
function formLabels(form: string): string[] | undefined {
  const line = /^labels:\s*\[([^\]]*)\]\s*(#.*)?$/m.exec(form);
  if (line?.[1] === undefined) return undefined;
  return line[1]
    .split(",")
    .map((label) => label.trim().replace(/^(["'])(.*)\1$/, "$2"))
    .filter((label) => label.length > 0);
}

/** The issue type a form sets, from its top-level `type:`. `undefined` when it sets none. */
function formType(form: string): string | undefined {
  return /^type:\s*(["']?)([^"'#\s][^"'#]*?)\1\s*(#.*)?$/m.exec(form)?.[2];
}

/** Each contact link's `url:`, whether it opens its list item or follows `name:`. */
function contactUrls(config: string): string[] {
  return [...config.matchAll(/^\s*(?:-\s+)?url:\s*(\S+)/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe("the label reader", () => {
  test("takes bare and quoted labels alike", () => {
    expect(formLabels(`name: Bug\nlabels: [bug, "needs-triage", 'x']\n`)).toEqual(["bug", "needs-triage", "x"]);
  });

  test("reads past a trailing comment", () => {
    expect(formLabels("labels: [bug] # applied on submit\n")).toEqual(["bug"]);
  });

  test("reads past a trailing comment that holds a bracket", () => {
    expect(formLabels("labels: [bug, needs-triage] # see [#707]\n")).toEqual(["bug", "needs-triage"]);
  });

  test("reports a form with no labels line as having none, not as empty", () => {
    expect(formLabels("name: Bug\nbody: []\n")).toBeUndefined();
  });

  test("ignores a nested labels key", () => {
    expect(formLabels("body:\n  - labels: [bug]\n")).toBeUndefined();
  });
});

describe("the type reader", () => {
  test("takes a bare or quoted type, past a trailing comment", () => {
    expect(formType("type: Bug\n")).toBe("Bug");
    expect(formType('type: "Feature" # set on submit\n')).toBe("Feature");
  });

  test("ignores a field's nested type", () => {
    expect(formType("body:\n  - type: textarea\n")).toBeUndefined();
  });
});

describe("the link reader", () => {
  test("takes a url that follows its name and one that opens its list item", () => {
    expect(contactUrls("  - name: A\n    url: https://a\n  - url: https://b\n    name: B\n")).toEqual([
      "https://a",
      "https://b",
    ]);
  });
});

describe("contributor intake", () => {
  let forms: string[];

  beforeAll(async () => {
    forms = (await readdir(TEMPLATES)).filter((file) => !/^config\.ya?ml$/.test(file)).sort();
  });

  // Every file but `config.yml` is a template, Markdown ones included, so a new one of either kind
  // fails here until it is added to this list. A Markdown template must write its front matter
  // `labels:` as a one-line `[a, b]` list, or the label check below cannot read it.
  test("finds the forms it holds", () => {
    expect(forms).toEqual(["bug.yml", "feature.yml"]);
  });

  test(`every issue form applies ${TRIAGE_LABEL}`, async () => {
    for (const file of forms) {
      const labels = formLabels(await readFile(resolve(TEMPLATES, file), "utf8"));
      expect(labels, file).toContain(TRIAGE_LABEL);
    }
  });

  test("every issue form sets an issue type the org defines", async () => {
    for (const file of forms) {
      const type = formType(await readFile(resolve(TEMPLATES, file), "utf8"));
      expect(ISSUE_TYPES, file).toContain(type);
    }
  });

  test("no issue form says what kind of issue it is with a label", async () => {
    for (const file of forms) {
      const labels = formLabels(await readFile(resolve(TEMPLATES, file), "utf8")) ?? [];
      expect(
        labels.filter((label) => KIND_LABELS.includes(label)),
        file,
      ).toEqual([]);
    }
  });

  test("blank issues are off", async () => {
    const config = await readFile(resolve(TEMPLATES, "config.yml"), "utf8");
    expect(config).toMatch(/^blank_issues_enabled:\s*false\s*(#.*)?$/m);
  });

  test("the only contact link is private disclosure", async () => {
    const config = await readFile(resolve(TEMPLATES, "config.yml"), "utf8");
    expect(contactUrls(config)).toEqual([ADVISORY_URL]);
  });

  test("the pull request template asks for the issue it closes", async () => {
    const template = await readFile(PR_TEMPLATE, "utf8");
    expect(template).toMatch(/^Closes #/m);
  });

  test("SECURITY.md sends a report to private disclosure", async () => {
    const policy = await readFile(SECURITY, "utf8");
    expect(policy).toContain(ADVISORY_URL);
  });
});
