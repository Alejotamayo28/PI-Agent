---
name: n8n-code-node
description: Handle any n8n Code node (or workflow with code/function nodes) request — paste, explanation, debugging, extraction, or general reading. Triggers when the user pastes a code/function node, pastes a workflow JSON with code nodes, or asks about / explains / debugs an n8n code node (even without pasting the full code). Always extracts the embedded JS/Python to /tmp/ and prints a ready-to-paste `nvim <path>` command (plus the absolute path) so the user can run it in their terminal. If the user asked a question, also answers it in chat.
---

# n8n Code Node Extractor

## Goal

Turn an n8n Code node (or a workflow with several) into clean `.js` / `.py` files under `/tmp/n8n-code-node/` and print a ready-to-paste `nvim <path>` command so the user can open the file in their editor. No tmux, no auto-open, no GUI launchers — the user runs the command themselves. If the user asked a question about the code, also answer it in chat.

## When to trigger

Trigger on **any** of these:

1. A single n8n Code node, e.g.
   ```json
   {"type":"n8n-nodes-base.code","name":"Normalize & Validate","parameters":{"mode":"runOnceForAllItems","jsCode":"…"}}
   ```
2. A workflow JSON with a top-level `nodes: […]` array containing one or more code/function nodes.
3. A raw escaped `jsCode` / `pythonCode` / `functionCode` string.
4. **A question about a code node** — "explain this code node", "what does this do?", "why is this failing?", "help me read this", "is this code node correct?", etc. — even if the user hasn't pasted the full node in the same message. If only a snippet is visible, extract what's there and ask for the rest if you need it.
5. The shorthand `"type":"code"` (as the user has been pasting) — treat it the same as `n8n-nodes-base.code`. Likewise for older `n8n-nodes-base.function` and `n8n-nodes-base.functionItem` nodes, which use `functionCode` instead of `jsCode`.

**When in doubt, trigger.** The cost of extracting is one file write; the cost of *not* triggering is the user having to ask twice.

## Languages

- `parameters.jsCode` or `parameters.functionCode` → JavaScript (`.js`)
- `parameters.pythonCode` → Python (`.py`)
- If a node has none of these, skip it and mention it in the report.

## Steps

1. **Save the input.** Use the `write` tool to dump whatever the user pasted (JSON object, workflow JSON, or raw string) to a temp file at `/tmp/n8n-code-node/_input.json`. If the user pasted a raw string, wrap it first:
   ```json
   {"name":"snippet","parameters":{"jsCode":"<the raw string>"}}
   ```
   This guarantees the parser below sees a uniform shape.

2. **Run a small Node.js extractor.** Use the helper script at `/tmp/n8n-code-node/_extract.mjs` (create it once, reuse forever):
   ```js
   // /tmp/n8n-code-node/_extract.mjs
   import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

   const data = JSON.parse(readFileSync(process.argv[2], "utf8"));
   const nodes = Array.isArray(data.nodes) ? data.nodes : [data];

   const seen = new Map();
   const out = [];
   for (const n of nodes) {
     const p = n.parameters ?? {};
     const code = p.pythonCode ?? p.jsCode ?? p.functionCode;
     if (!code) continue;
     const lang = p.pythonCode && !p.jsCode && !p.functionCode ? "py" : "js";
     const name = n.name || "snippet";
     const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";

     let suffix = "";
     const count = seen.get(slug) ?? 0;
     if (count > 0) suffix = `-${count}`;
     seen.set(slug, count + 1);

     const path = `/tmp/n8n-code-node/${slug}${suffix}-${Date.now()}.${lang}`;
     mkdirSync("/tmp/n8n-code-node", { recursive: true });
     writeFileSync(path, code);
     out.push({ name, lang, path });
   }
   console.log(JSON.stringify(out));
   ```
   Run it: `node /tmp/n8n-code-node/_extract.mjs /tmp/n8n-code-node/_input.json`

3. **Report back** with the absolute path of each extracted file plus a ready-to-paste `nvim <path>` command for the first one:
   ```
   Extracted 2 code nodes:
     • Normalize & Validate (js) → /tmp/n8n-code-node/normalize-validate-1782712629606.js
     • Transform (py)           → /tmp/n8n-code-node/transform-1782712629607.py

   Run in your terminal:
     nvim /tmp/n8n-code-node/normalize-validate-1782712629606.js
   ```
   The user copies the `nvim` line and pastes it into their terminal. The other paths are listed so they can swap them in (or open multiple panes via tmux by hand, if they want).

   **If the user asked a question** (explain, debug, "what does this do?", etc.), also answer it in chat *after* the extraction. The file is for *their* reading; your chat response is for *your* analysis. Both are valuable — a typical n8n dev is learning to read these, so pairing your explanation with the clean source is the strongest teaching format.

4. **Clean up the input file** afterwards: `rm /tmp/n8n-code-node/_input.json`. Keep `_extract.mjs` — reuse it on every future call. (User can `rm -rf /tmp/n8n-code-node` to wipe everything.)

## Filename collisions

Two nodes with the same display name (or same slug after normalization) get `-1`, `-2`, … suffixes. The script handles this with the `seen` map.

## Don't

- Don't try to *run* the extracted code. n8n has its own runtime; the user just wants to read.
- Don't reformat, lint, or "fix" the code. Preserve what n8n actually stored, including `{{ $json.foo }}` expressions — leave them as literal text.
- Don't auto-open with `xdg-open`, `tmux split-window`, `nvim`, or anything else. **Always print the command and let the user run it themselves.**
- Don't echo the **full** code back into chat — the file is for that. But short snippets (a regex, a function signature, a 3–5 line excerpt) are fine and useful when explaining or debugging.
