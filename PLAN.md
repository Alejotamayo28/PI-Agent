# Plan: Group Vim Chat Navigation Separators

## Context

The `extensions/vim-chat-navigation.ts` overlay currently renders a muted separator before every `ChatHistoryItem`. In real chat history, one assistant response can contain multiple related entries, such as assistant thinking/text, tool calls, and tool results. This creates many repeated horizontal separator lines.

Desired outcome: render only conversation-turn section separators:

- A `PROMPT` separator above each user prompt.
- An `AGENT RESULT` separator above the following assistant/result block.
- Tool results, bash executions, and related non-user entries should remain visually inside the same agent-result block instead of each getting their own separator.

Example target shape:

```text
──────────────────────────── PROMPT ────────────────────────────
 USER 07:21 PM
  User message...

────────────────────────── AGENT RESULT ─────────────────────────
π ASSISTANT · model 07:21 PM
  Assistant text / thinking / tool call...

🔧 TOOL read · OK 07:21 PM
  Tool output...
```

## Approach

Keep the existing message extraction and line rendering flow, but change where separator rows are inserted.

Instead of inserting a generic `separator` before every item in `ChatHistoryNavigator.getRenderedLines`, compute whether the current item starts a new section:

- User messages start a `PROMPT` section.
- Non-user messages start an `AGENT RESULT` section only when the previous rendered item was a user message, or when the transcript starts with a non-user item.
- Consecutive non-user items do not get additional separators.

Represent section separators as rendered lines with a label so the render step can draw centered text such as `PROMPT` or `AGENT RESULT` on the horizontal rule.

## Files to modify

- `extensions/vim-chat-navigation.ts`

## Reuse

Existing code to reuse:

- `getChatHistoryItems` / `formatMessageEntry` in `extensions/vim-chat-navigation.ts` for preserving current transcript item extraction.
- `ChatHistoryNavigator.getRenderedLines` for the single place where transcript rows are built.
- `ChatHistoryNavigator.render` separator branch for drawing the horizontal rule.
- `visibleWidth` and `truncateToWidth` imports already used for terminal-width-safe layout.
- Existing visual selection/yank logic should continue to operate on rendered lines.

## Steps

- [x] Extend `RenderedLine` so separator rows can optionally carry a section label, e.g. `PROMPT` or `AGENT RESULT`.
- [x] Add a small helper that determines whether an item should start a section separator based on the current item role and previous item role.
- [x] Update `getRenderedLines` to insert labeled separators only at section boundaries rather than before every item.
- [x] Update the separator rendering branch in `render` to draw a centered label within the horizontal rule while preserving selected/visual-line highlighting.
- [x] Ensure `findItemTitleLine`, group navigation (`h`/`l`), visual selection, and yank behavior still work with fewer separator rows.
- [x] Keep the empty-transcript fallback unchanged.

## Verification

Manual checks in TUI:

- [x] Open chat navigation with `Esc`.
- [x] Confirm a normal user -> assistant turn shows exactly two separators: `PROMPT` and `AGENT RESULT`.
- [x] Confirm assistant tool calls/results remain under the same `AGENT RESULT` separator without extra lines.
- [x] Confirm multiple turns repeat as `PROMPT`, `AGENT RESULT`, `PROMPT`, `AGENT RESULT`.
- [x] Confirm `j`/`k` line navigation and `h`/`l` message navigation still work.
- [x] Confirm visual-line and visual-char yanking still includes the expected transcript text.
- [x] Confirm no-session state still displays correctly.
