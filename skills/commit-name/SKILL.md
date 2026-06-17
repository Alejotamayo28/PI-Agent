---
name: commit-name
description: Analyze current git changes and suggest a concise commit name. Use when the user asks for a commit name, commit title, commit message subject, or wants to summarize current changes for a commit.
model: "gpt-5.4-mini"
---

# Commit Name

Analyze the current repository changes and return a concise commit name.

## Safety rules

- Do not modify files.
- Do not run `git add`.
- Do not run `git commit`.
- Do not run mutating git commands such as `git reset`, `git checkout`, `git switch`, `git restore`, `git clean`, `git stash`, `git merge`, `git rebase`, or `git tag`.
- Only inspect repository state and file contents.
- If not inside a git repository, say so and stop.

## Analysis rules

- Prefer staged changes if staged changes exist.
- If no staged changes exist, analyze unstaged tracked changes.
- Include untracked files by inspecting their paths and, when useful, their relevant contents.
- Ignore unrelated generated/noisy files when the main intent is clear.
- Infer the user-facing purpose of the changes, not just the files touched.
- Return one best commit name.
- Keep it short, clear, imperative or descriptive, and suitable as a git commit subject.
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

2. Inspect status:

```bash
git status --short
```

3. Check staged changes first:

```bash
git diff --cached --stat
git diff --cached
```

4. If there are no staged changes, inspect unstaged tracked changes:

```bash
git diff --stat
git diff
```

5. For untracked files, inspect only relevant files using `read` or safe read-only shell commands such as:

```bash
git ls-files --others --exclude-standard
```

6. Return exactly this format:

```text
Suggested commit name:
<commit name>
```

If useful, add one short explanation after the commit name, but do not include a long analysis unless the user asks.
