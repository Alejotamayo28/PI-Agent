# Plan: Tool Accordion in Vim Chat Navigation

## Context

The chat navigator currently shows every assistant tool call and tool result inline. This makes agent responses noisy because tool commands, arguments, outputs, and file reads can take many screen lines.

Desired outcome: reduce visual noise by rendering tool activity as compact accordion rows that can be expanded when the user wants details.

Example collapsed view:

```text
────────────────────────── AGENT RESULT ─────────────────────────
π ASSISTANT · gpt-5.5 07:48 PM
  [thinking]
  Short assistant/thinking text...

  ▶ TOOL bash · OK · git status --short
  ▶ TOOL read · OK · PLAN.md
```

Example expanded view:

```text
────────────────────────── AGENT RESULT ─────────────────────────
π ASSISTANT · gpt-5.5 07:48 PM
  [thinking]
  Short assistant/thinking text...

  ▼ TOOL bash · OK · git status --short
      command:
        git status --short

      output:
         M extensions/vim-chat-navigation.ts
         M settings.json
        ?? PLAN.md

  ▶ TOOL read · OK · PLAN.md
```

## Approach

Keep the current transcript extraction and navigation model, but enrich tool-related `ChatHistoryItem`s so the renderer can decide between compact and expanded output.

Recommended behavior:

- Tool result entries (`role: "toolResult"`) and bash execution entries (`role: "bashExecution"`) become accordion-capable items.
- Accordion-capable items render as one compact title row by default.
- Pressing `Enter` while the selected line belongs to an accordion-capable item toggles that item expanded/collapsed.
- Expanded items render their existing body lines below the compact row.
- Assistant text remains readable; only separate tool-result/bash items are collapsed. Inline `[tool call: ...]` blocks inside assistant messages stay as-is for the first implementation.
- Visual selection/yank uses the text currently rendered: collapsed tools yank only the compact summary; expanded tools yank the summary plus details.
- All accordion-capable tool entries start collapsed whenever the overlay opens.
- Compact summaries prioritize action + status: tool name/status plus the command, path, or first meaningful argument.

## Files to modify

- `extensions/vim-chat-navigation.ts`

## Reuse

Existing code to reuse:

- `ChatHistoryItem.role` to identify `toolResult` and `bashExecution` items.
- `formatToolResultMessage` and `formatBashExecutionMessage` for the current detailed body content.
- `ChatHistoryNavigator.handleInput`, `handleNormalInput`, and current `Enter` handling for adding a toggle action.
- `ChatHistoryNavigator.getRenderedLines` as the central place to render collapsed vs expanded tool rows.
- `formatTitle`, `wrapPlainLine`, `styleMarkdownLine`, `renderHistoryLine`, and existing selection/yank logic.
- `requestRender` and cached-line invalidation pattern for updating the overlay after toggles.

## Steps

- [x] Add metadata to `ChatHistoryItem` for optional accordion behavior, including a compact summary string.
- [x] Populate accordion metadata in `formatToolResultMessage` and `formatBashExecutionMessage`.
- [x] Add `expandedAccordionItems` state to `ChatHistoryNavigator`, keyed by item index.
- [x] Add helpers to detect accordion-capable items and to toggle the currently selected item.
- [x] Update `handleInput` / `handleNormalInput` so `Enter` toggles accordion items in normal mode.
- [x] Update `getRenderedLines` so collapsed accordion items render one compact row and expanded items render compact row plus existing detailed body.
- [x] Add a rendered-line kind or flag if needed so accordion rows can show `▶` / `▼` while still participating in navigation and selection.
- [x] Update header help text to mention accordion toggling.
- [x] Ensure cache invalidation occurs when an item expands/collapses.
- [x] Verify navigation, visual selection, yanking, and grouped `PROMPT` / `AGENT RESULT` separators still behave correctly.

## Verification

Manual checks in TUI:

- [x] Open chat navigation with `Esc`.
- [x] Confirm tool result and bash execution items are collapsed by default.
- [x] Confirm `Enter` toggles the selected tool item open/closed.
- [x] Confirm `Space` does not toggle accordion rows.
- [x] Confirm non-tool items ignore toggle keys and keep normal behavior.
- [x] Confirm expanded tool details match the current pre-accordion body content.
- [x] Confirm collapsed summaries are useful for bash, read, grep, and generic tool results.
- [x] Confirm `j`/`k` line navigation works across collapsed and expanded items.
- [x] Confirm `h`/`l` message navigation lands on sensible title/summary rows.
- [x] Confirm visual-line and visual-char yanking works for both collapsed and expanded tool items.
- [x] Confirm no-session state still displays correctly.

## Decisions

- Toggle key: `Enter` only.
- Default state: all accordion-capable tool entries start collapsed.
- First-version scope: collapse separate `toolResult` and `bashExecution` entries only; leave inline assistant `[tool call: ...]` blocks unchanged.
- Compact summary: prioritize action + status, using tool name/status plus command, path, or first meaningful argument.
