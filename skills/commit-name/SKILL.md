---
name: commit-name
description: Analyze current git changes and suggest one or more commit names with ready-to-paste git commands. Use when the user asks for a commit name, commit title, commit message subject, or wants to summarize current changes for one or more commits. Splits unrelated changes into separate commits with staging commands.
model: "gpt-5.4-mini"
---

# Commit Name

Analyze the current repository changes and return concise commit name(s), grouped by concern, with ready-to-paste staging and commit commands.

## Safety rules

- Do not modify files.
- Do not run `git add`, `git commit`, or any other mutating git command.
- Do not run `git reset`, `git checkout`, `git switch`, `git restore`, `git clean`, `git stash`, `git merge`, `git rebase`, or `git tag`.
- Only inspect repository state and file contents.
- All git commands in the output are **suggestions to be copied and run manually**. Never execute them.
- Prefer explicit file paths over `git add .` or `git add -A`.
- Quote paths that contain spaces or special characters.
- If any path looks sensitive (`.env`, `*.pem`, `id_rsa`, `credentials.*`, tokens, keys), flag it explicitly and do not include it in any command.
- If not inside a git repository, say so and stop.

## Analysis rules

- Collect changes from three sources in parallel — none is optional when it has content:
  1. **Staged**: `git diff --cached`
  2. **Unstaged tracked**: `git diff`
  3. **Untracked**: `git ls-files --others --exclude-standard`, then read small/relevant files for content
- Do not treat tracked changes as a "primary" signal and untracked as secondary. All three are first-class.
- Determine if the changes form **one coherent change** or **multiple unrelated changes**.
- Heuristics for grouping by concern:
  - Files that reference each other (imports, types, configs read by the code, tests covering the code) → same group.
  - Files with different themes (a new feature vs an unrelated fix vs a chore) → different groups.
  - Untracked files that aren't referenced by tracked changes are likely a separate group.
- If unsure whether changes are related, **default to grouping** (one commit). Splitting post-hoc is easier than unsplitting.
- For each group, infer the user-facing purpose, not just the files touched.
- Order groups by **dependency**: if group B depends on changes from group A (e.g., a new module imported by modified code), A comes first.
- Commit names: short, clear, imperative or descriptive, suitable as git commit subjects.
- Target ≤50 characters per commit name (hard cap 72).
- Prefer Conventional Commit style when obvious:
  - `feat: ...`
  - `fix: ...`
  - `refactor: ...`
  - `docs: ...`
  - `test: ...`
  - `chore: ...`
  - `style: ...`
  - `build: ...`
  - `ci: ...`

## Workflow

1. Verify the current directory is inside a git repository:

```bash
git rev-parse --is-inside-work-tree
```

2. Get the full picture with status:

```bash
git status --short
```

3. Collect from all three sources in parallel — do not skip any:

```bash
# Staged
git diff --cached --stat
git diff --cached

# Unstaged tracked
git diff --stat
git diff

# Untracked
git ls-files --others --exclude-standard
```

4. For each untracked file, decide whether to read its content:
   - Read small text files that look relevant to infer purpose (use `read`).
   - Skip large files, binaries, lockfiles, generated outputs, vendored deps.
   - If unsure, check size with `stat -c '%s %n' <path>` first.

5. Synthesize:
   - Group files by concern using the heuristics above.
   - If only one group → single commit output.
   - If multiple groups → multi-commit output, ordered by dependency.

6. Render the appropriate output format.

## Output format

### Single coherent change

```text
Suggested commit name:
<commit name>

git add <path1> <path2> ...
git commit -m "<commit name>"

Verify: git status --short
```

### Multiple unrelated changes

```text
Suggested commits (in order, dependencies first):

1. <commit name>
   Files: <path1>, <path2>
   git add <path1> <path2>
   git commit -m "<commit name>"
   git status --short

2. <commit name>
   Files: <path3>
   git add <path3>
   git commit -m "<commit name>"
   git status --short

<one short line explaining the split, e.g. "Split because A and B are unrelated concerns.">
```

### Notes

- The verify commands (`git status --short`) are suggestions, not executed.
- If the user wants a single commit even with unrelated changes, they can ask to collapse the suggestion.
- Do not include a long analysis unless the user asks. A one-line explanation of the split is the maximum.
