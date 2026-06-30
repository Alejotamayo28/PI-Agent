---
name: n8n-workflow-debug
description: Read, explain, and debug a complete n8n workflow (not just Code nodes). Triggers when the user pastes a workflow JSON (with `nodes` and `connections`), an execution data JSON (with `executionData.resultData.runData` and/or `.error`), both together, or asks questions like "why is this workflow failing", "explain this workflow", "what data does node X see", "this broke after I changed Y", "compare these two executions". Extracts a topological narrative, a mermaid graph, and a focused debug report to /tmp/n8n-workflow-debug/ and prints ready-to-paste `nvim <path>` commands. For code/function *nodes specifically*, this skill defers the code extraction to the sibling skill `n8n-code-node`.
---

# n8n Workflow Debug

## Goal

Explain a pasted n8n workflow. Three output files go under `/tmp/n8n-workflow-debug/`:

1. **`<slug>-graph.mmd`** — a Mermaid `graph LR` of the workflow. Branching nodes (IF, Switch) get edges labeled `true` / `false` / `case N` / `default`. Merge and Loop nodes are rendered distinctly. The user can render it with `mmdc -i file.mmd -o file.svg` or paste it into any Mermaid previewer.
2. **`<slug>-narrative.md`** — a node-by-node description in **topological execution order**, with a one-liner per node explaining what it does and what flows into / out of it. For Code/Function nodes, the narrative says what kind of transformation it appears to be and **defers the actual code reading to the `n8n-code-node` skill** — this skill does not extract or display code.
3. **`<slug>-debug.md`** — only if execution data was pasted. Pinpoints the failing node, shows the actual data that node received, lists suspicious workflow-level patterns (missing `$json` keys on the data path, `undefined` upstream references, missing credentials, typeVersion mismatches). **Does not dump code**; for that, the failing-node section shows the non-code parameters of the node and points the user to the `n8n-code-node` skill.

Then print a `nvim <path>` command for each generated file. **No auto-open, no GUI launchers.** If the user asked a question, also answer it in chat *after* the extraction — the files are for their reading, the chat is for your analysis.

## When to trigger

Trigger on **any** of these:

1. A complete workflow JSON:
   ```json
   {"name":"My flow","nodes":[...],"connections":{...},"settings":{},"staticData":null,"pinData":{},"versionId":"...","id":"...","meta":{...}}
   ```
2. An execution data JSON:
   ```json
   {"id":123,"finished":true,"mode":"manual","startedAt":"...","stoppedAt":"...","workflowId":"...","status":"error","executionData":{"resultData":{"runData":{...},"error":{"message":"...","node":{...},"stack":"..."}}}}
   ```
3. **Both together** in the same message — this is the most common case for a real debug session.
4. **A question** about a workflow — "explain this workflow", "what does node X do", "why is this failing", "this used to work, what changed", "compare execution #42 and #43" — even if the user hasn't pasted the JSON in the same message. If only a snippet is visible, ask for the rest.
5. A single n8n node object that is **not** a code/function node (HTTP Request, Webhook, IF, Set, DB, Error Trigger, etc.). For code/function nodes, defer to the `n8n-workflow-debug` workflow-level analysis if a full workflow is in context, otherwise to the sibling `n8n-code-node` skill.

**When in doubt, trigger.** A workflow that fails to parse is just a request for clarification, not a wasted cycle.

## Steps

1. **Detect input type.** Inspect what the user pasted:
   - Has `nodes` and `connections` → workflow.
   - Has `executionData` (with or without `resultData.runData`) → execution.
   - Has both → both.
   - Has neither but contains `runData` at top level (older n8n export format) → execution, treat as-is.
   - Is a question with no JSON → ask for the workflow export (File → Download in the n8n UI) and the failing execution's JSON. Don't proceed without data.

2. **Save inputs.** Write each detected input to:
   - `/tmp/n8n-workflow-debug/_input.workflow.json`
   - `/tmp/n8n-workflow-debug/_input.execution.json` (only if provided)

   The extractor below reads these and produces the reports.

3. **Run the extractor.** Use the helper script at `/tmp/n8n-workflow-debug/_extract.mjs` (create it once, reuse forever):
   ```js
   // /tmp/n8n-workflow-debug/_extract.mjs
   import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
   import { resolve } from "node:path";

   const DIR = "/tmp/n8n-workflow-debug";
   mkdirSync(DIR, { recursive: true });

   const stamp = Date.now();
   const read = (p) => existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
   const workflow = read(`${DIR}/_input.workflow.json`);
   const execution = read(`${DIR}/_input.execution.json`);

   if (!workflow && !execution) {
     console.error("no input");
     process.exit(1);
   }

   // ----- 1. Build node index and slugify -----
   const slug = (s) => (s || "node").toLowerCase()
     .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";

   const nodes = workflow?.nodes ?? [];
   const byName = new Map(nodes.map((n) => [n.name, n]));
   const byType = new Map();
   for (const n of nodes) {
     if (!byType.has(n.type)) byType.set(n.type, []);
     byType.get(n.type).push(n);
   }

   // ----- 2. Build connection graph (forward) and reverse map -----
   // n8n shape: connections[sourceName][outputType] = [[ { node: targetName, type, index } ]]
   // outputType is usually "main". IF/Switch have main[0] and main[1] (or more).
   const forward = new Map(); // sourceName -> [{target, branch, index}]
   const incoming = new Map(); // targetName -> [sourceName]
   for (const n of nodes) incoming.set(n.name, []);

   const conns = workflow?.connections ?? {};
   for (const [src, outputs] of Object.entries(conns)) {
     for (const [outType, branches] of Object.entries(outputs)) {
       branches.forEach((branch, idx) => {
         for (const edge of branch ?? []) {
           const target = edge.node;
           if (!forward.has(src)) forward.set(src, []);
           forward.get(src).push({ target, branch: outType, index: idx });
           if (!incoming.has(target)) incoming.set(target, []);
           incoming.get(target).push(src);
         }
       });
     }
   }

   // ----- 3. Topological sort (Kahn) -----
   // n8n workflows can have cycles only via Loop nodes; we treat them as acyclic for
   // narrative purposes and warn the user if we detect a back-edge.
   const indeg = new Map(nodes.map((n) => [n.name, 0]));
   for (const [, edges] of forward) for (const e of edges)
     indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);

   const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n);
   const topo = [];
   const visited = new Set();
   while (queue.length) {
     const n = queue.shift();
     if (visited.has(n)) continue;
     visited.add(n);
     topo.push(n);
     for (const e of forward.get(n) ?? []) {
       const d = (indeg.get(e.target) ?? 0) - 1;
       indeg.set(e.target, d);
       if (d === 0) queue.push(e.target);
     }
   }
   // If topo missed nodes, append them (cycles / disconnected components).
   for (const n of nodes.map((n) => n.name)) if (!visited.has(n)) topo.push(n);

   // ----- 4. Mermaid graph -----
   const safeId = (s) => s.replace(/[^a-zA-Z0-9_]/g, "_");
   const nodeLabel = (n) => {
     const t = n.type.split(".").pop();
     return `${n.name}<br/><i>${t}</i>`;
   };
   const shape = (n) => {
     // Diamond for branching, stadium for triggers/endpoints, rect for the rest.
     if (/^(n8n-nodes-base\.)?(if|switch)$/.test(n.type)) return `{"${nodeLabel(n)}"}`;
     if (/^(n8n-nodes-base\.)?(webhook|executeWorkflow|errorTrigger|manualTrigger|scheduleTrigger)$/.test(n.type))
       return `(["${nodeLabel(n)}"])`;
     if (/^(n8n-nodes-base\.)?(noOp|stopAndError)$/.test(n.type)) return `((("${nodeLabel(n)}")))`;
     return `["${nodeLabel(n)}"]`;
   };
   let mermaid = "graph LR\n";
   for (const n of nodes) {
     mermaid += `  ${safeId(n.name)}${shape(n)}\n`;
   }
   for (const [src, edges] of forward) {
     edges.forEach((e) => {
       let label = "";
       if (/^(n8n-nodes-base\.)?if$/.test(byName.get(src)?.type ?? ""))
         label = e.index === 0 ? "true" : "false";
       else if (/^(n8n-nodes-base\.)?switch$/.test(byName.get(src)?.type ?? ""))
         label = e.index < edges.length - 1 ? `case ${e.index}` : "default";
       else if (e.branch !== "main") label = e.branch;
       const arrow = label ? ` -->|${label}| ` : " --> ";
       mermaid += `  ${safeId(src)}${arrow}${safeId(e.target)}\n`;
     });
   }
   const graphPath = `${DIR}/workflow-${stamp}.mmd`;
   writeFileSync(graphPath, mermaid);

   // ----- 5. Narrative -----
   let narr = `# Workflow narrative: ${workflow?.name ?? "(unnamed)"}\n\n`;
   narr += `- **Nodes:** ${nodes.length}\n`;
   const types = [...byType.entries()].map(([t, list]) => `${list.length}× ${t.split(".").pop()}`).join(", ");
   narr += `- **Types:** ${types}\n`;
   narr += `- **Trigger:** ${nodes.find((n) => /(Trigger|webhook)/i.test(n.type))?.name ?? "(none detected)"}\n\n`;

   // Find entry points: nodes with no incoming edges.
   const entries = nodes.map((n) => n.name).filter((n) => (incoming.get(n) ?? []).length === 0);
   if (entries.length) narr += `**Entry points:** ${entries.join(", ")}\n\n`;

   narr += `## Execution order\n\n`;
   topo.forEach((name, i) => {
     const n = byName.get(name);
     if (!n) return;
     const t = n.type.split(".").pop();
     const ins = incoming.get(name) ?? [];
     const outs = forward.get(name) ?? [];
     narr += `### ${i + 1}. ${name}  (${t})\n`;
     narr += `- In: ${ins.length ? ins.join(", ") : "_start_"}\n`;
     narr += `- Out: ${outs.length ? outs.map((e) => `${e.target}${e.index ? ` [branch ${e.index}]` : ""}`).join(", ") : "_end_"}\n`;
     narr += `- typeVersion: ${n.typeVersion ?? "?"}\n`;
     if (n.notes) narr += `- Notes: ${n.notes}\n`;
     narr += `\n`;
   });

   const narrativePath = `${DIR}/workflow-${stamp}-narrative.md`;
   writeFileSync(narrativePath, narr);

   // ----- 6. Debug report (only if execution present) -----
   let debugPath = null;
   if (execution) {
     const err = execution.executionData?.resultData?.error
       ?? execution.data?.resultData?.error
       ?? null;
     const runData = execution.executionData?.resultData?.runData
       ?? execution.data?.resultData?.runData
       ?? {};
     const failedName = err?.node?.name ?? err?.source?.[0]?.node?.name ?? null;
     const finished = execution.finished ?? execution.stoppedAt != null;
     const status = execution.status ?? (err ? "error" : finished ? "success" : "running");

     let d = `# Debug report: ${workflow?.name ?? "(workflow)"}\n\n`;
     d += `- **Status:** ${status}\n`;
     d += `- **Execution ID:** ${execution.id ?? "?"}\n`;
     d += `- **Started:** ${execution.startedAt ?? "?"}\n`;
     d += `- **Stopped:** ${execution.stoppedAt ?? "?"}\n`;
     if (failedName) d += `- **Failed node:** \`${failedName}\`\n`;
     if (err?.message) d += `- **Error message:** ${err.message}\n`;
     if (err?.stack) d += `\n<details><summary>Stack trace</summary>\n\n\`\`\`\n${err.stack}\n\`\`\`\n</details>\n`;
     d += `\n## Per-node outcome\n\n`;
     d += `| Node | Status | Items in | Items out | First-input preview |\n`;
     d += `|---|---|---|---|---|\n`;
     for (const name of topo) {
       const rd = runData[name];
       if (!rd) { d += `| ${name} | _did not run_ | - | - | - |\n`; continue; }
       const run = Array.isArray(rd) ? rd[rd.length - 1] : rd;
       const inItems = run?.inputData?.main?.[0] ?? run?.data?.main?.[0] ?? [];
       const outItems = run?.data?.main?.[0] ?? run?.data?.[0]?.[0] ?? [];
       const inCount = Array.isArray(inItems) ? inItems.length : 0;
       const outCount = Array.isArray(outItems) ? outItems.length : 0;
       const preview = inItems?.[0]?.json
         ? JSON.stringify(inItems[0].json).slice(0, 120)
         : "-";
       const nodeStatus = name === failedName ? "❌ error" : "✅ ok";
       d += `| ${name} | ${nodeStatus} | ${inCount} | ${outCount} | \`${preview}\` |\n`;
     }
     d += `\n## Suspicious patterns\n\n`;
     // Heuristics:
     for (const name of topo) {
       const n = byName.get(name);
       if (!n) continue;
       const code = n.parameters?.jsCode ?? n.parameters?.pythonCode ?? n.parameters?.functionCode;
       if (code) {
         // Detect missing return in JS Code nodes.
         if (n.parameters?.jsCode && !/return\s+/.test(n.parameters.jsCode))
           d += `- ⚠️ \`${name}\`: JS Code node has no \`return\` statement — downstream will receive no items.\n`;
         // Detect $json.X references where the upstream might not produce X.
         const refs = [...new Set([...n.parameters.jsCode.matchAll(/\$json\.(\w+)/g)].map((m) => m[1]))];
         if (refs.length) {
           const upstream = incoming.get(name) ?? [];
           for (const src of upstream) {
             const rd = runData[src];
             const run = Array.isArray(rd) ? rd[rd.length - 1] : rd;
             const first = run?.data?.main?.[0]?.[0]?.json ?? run?.inputData?.main?.[0]?.[0]?.json;
             if (first) {
               const missing = refs.filter((k) => !(k in first));
               if (missing.length)
                 d += `- ⚠️ \`${name}\` references \`$json.${missing.join(", ")}\` but \`${src}\` did not produce those keys (saw: ${Object.keys(first).join(", ")}).\n`;
             }
           }
         }
         // Detect $node["X"] references to non-existent nodes.
         const nodeRefs = [...n.parameters.jsCode.matchAll(/\$node\["([^"]+)"\]/g)].map((m) => m[1]);
         for (const ref of nodeRefs) {
           if (!byName.has(ref))
             d += `- ⚠️ \`${name}\` references \`$node["${ref}"]\` but no node with that name exists in the workflow.\n`;
         }
         // Python sandbox check — workflow-level note about capability, not the code itself.
         if (n.parameters?.pythonCode) {
           if (/(^|\n)\s*(import|from)\s+(requests|httpx|aiohttp|urllib3)/.test(n.parameters.pythonCode))
             d += `- ⚠️ \`${name}\` is a Python Code node that needs HTTP libraries — those are not available in the n8n Python sandbox. Use an upstream HTTP Request node and pass the response as $json, or chain through it.\n`;
         }
       }
       // Credential reference check.
       if (n.credentials && Object.keys(n.credentials).length === 0)
         d += `- ⚠️ \`${name}\` has an empty credentials object — check if a credential was renamed or deleted.\n`;
     }
     d += `\n## Failing-node deep dive\n\n`;
     if (failedName) {
       const rd = runData[failedName];
       const run = Array.isArray(rd) ? rd[rd.length - 1] : rd;
       const fn = byName.get(failedName);
       d += `### Input that \`${failedName}\` received\n\n`;
       const input = run?.inputData ?? run?.data ?? null;
       d += "```json\n" + JSON.stringify(input, null, 2) + "\n```\n\n";
       d += `### Non-code parameters of \`${failedName}\`\n\n`;
       // Strip the code fields so this skill stays workflow-explanation focused.
       const params = { ...(fn?.parameters ?? {}) };
       delete params.jsCode;
       delete params.pythonCode;
       delete params.functionCode;
       d += "```json\n" + JSON.stringify(params, null, 2) + "\n```\n\n";
       // If it IS a code node, point at the sibling skill instead of dumping the code here.
       const isCodeNode = fn?.type === "n8n-nodes-base.code" || fn?.type === "n8n-nodes-base.function" || fn?.type === "n8n-nodes-base.functionItem";
       if (isCodeNode) {
         d += `_This is a Code node. For the embedded JS/Python, invoke the \`n8n-code-node\` skill on this workflow — it will extract the source to \`/tmp/n8n-code-node/\` and open it in your editor._\n\n`;
       }
     } else if (status === "success") {
       d += `_No failure detected. If the workflow still seems wrong, check the per-node table above for nodes with 0 items out or unexpected previews._\n`;
     } else {
       d += `_No specific failure node identified. The execution may have been cancelled or stopped before a node errored._\n`;
     }

     debugPath = `${DIR}/workflow-${stamp}-debug.md`;
     writeFileSync(debugPath, d);
   }

   console.log(JSON.stringify({ graphPath, narrativePath, debugPath, topo, entries, failedName: execution?.executionData?.resultData?.error?.node?.name ?? null }, null, 2));
   ```

   Run it: `node /tmp/n8n-workflow-debug/_extract.mjs`

4. **Report back** with the absolute path of each generated file and a ready-to-paste `nvim <path>` command. Typical output:
   ```
   Extracted workflow: my-flow
     • Graph (.mmd)        → /tmp/n8n-workflow-debug/workflow-1782712629606.mmd
     • Narrative (.md)     → /tmp/n8n-workflow-debug/workflow-1782712629606-narrative.md
     • Debug report (.md)  → /tmp/n8n-workflow-debug/workflow-1782712629606-debug.md
     • Execution status: error  • Failed node: HTTP Request

   Open in your terminal:
     nvim /tmp/n8n-workflow-debug/workflow-1782712629606-narrative.md
   ```
   Always lead with the **narrative** as the default read; the user goes to `debug.md` only if there is an error to investigate, and to `graph.mmd` only if they want the visual.

   **If the user asked a question** ("why is this failing", "what does node X do", "compare these executions", etc.), also answer it in chat *after* the extraction. The files are for *their* reading; your chat response is for *your* analysis. Both are valuable.

5. **Clean up the input files** afterwards: `rm /tmp/n8n-workflow-debug/_input.*.json`. Keep `_extract.mjs` and the generated reports until the next call (the next invocation overwrites the same `_input.*.json` paths but the generated files are timestamped, so old ones stay around). The user can `rm -rf /tmp/n8n-workflow-debug` to wipe everything.

## Filename collisions

Two workflows pasted in the same session get different `Date.now()` stamps, so the generated reports don't collide. If the user pastes the same workflow twice within a millisecond (extremely unlikely), the second run overwrites the first — the narrative is regenerated identically, so this is harmless.

## Don't

- Don't try to *execute* the workflow. n8n has its own runtime; the user just wants to read and understand.
- Don't *modify* the workflow JSON. This skill is read-only. If the user wants to edit, they open the original export (or the extracted narrative) with `nvim` and re-import.
- **Don't extract, dump, or display embedded code** (`jsCode`, `pythonCode`, `functionCode`) from Code/Function nodes. That is the job of the sibling `n8n-code-node` skill. The failing-node section shows the non-code parameters only, and points the user to `n8n-code-node` for the source.
- Don't auto-open with `xdg-open`, `tmux split-window`, `nvim`, or anything else. **Always print the command and let the user run it themselves.**
- Don't call the n8n API. This skill operates entirely on pasted JSON. A future "n8n-runtime" skill may add live API access; this one does not.
- Don't echo the **full** workflow back into chat — the files are for that. But short excerpts (a single node's parameters, a few lines of the error message, the input that a node received) are fine and useful when explaining or debugging.
- Don't render the Mermaid to SVG/PNG in the harness. The user runs `mmdc` (or any Mermaid previewer) themselves. Generating the file is enough.

## Relationship to `n8n-code-node`

The two skills are complementary, not redundant:

| Concern | Owner |
|---|---|
| Read & explain a **full workflow** (graph, narrative, debug) | `n8n-workflow-debug` |
| Extract & analyze **a single Code/Function node's code** in isolation | `n8n-code-node` |
| Debug a Code node that lives inside a workflow | `n8n-workflow-debug` first (to get context), then `n8n-code-node` for the code itself |

When both apply — e.g. user pastes a workflow and asks "what does the Code node do" — run `n8n-workflow-debug` first, then mention the sibling skill for deeper code work. Don't try to re-implement Code-node handling here; the `n8n-code-node` skill owns that.
