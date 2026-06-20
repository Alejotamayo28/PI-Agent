# Plan: Fix Vim chat navigation missing scroll API

## Context

The current `extensions/vim-chat-navigation.ts` correctly implements modal behavior:

- `Esc` switches from prompt/INSERT mode to CHAT NAV mode.
- `Enter` returns from CHAT NAV mode to prompt/INSERT mode without submitting.
- `h/j/k/l` are captured and do not type into the prompt.

The problem is the warning:

```text
mode: CHAT NAV — h/j/k/l captured; message scroll API unavailable
```

This happens because the extension currently probes the Pi TUI runtime for undocumented methods such as `scrollMessagesUp`, `scrollChatUp`, or `scrollUp`. Pi's public extension API does not expose a stable method for scrolling the built-in message pane from a custom editor, so the probe fails.

## Approach

Replace the unsupported message-pane scroll probing with a supported extension-level history navigator.

Recommended implementation:

- Keep the existing custom editor for prompt/INSERT behavior.
- When the user presses `Esc`, open a focused CHAT NAV overlay or custom component using `ctx.ui.custom(..., { overlay: true })`.
- The overlay renders the current session history from `ctx.sessionManager.getBranch()`.
- The overlay owns keyboard input while active:
  - `j`: move down through rendered chat/history lines or messages.
  - `k`: move up through rendered chat/history lines or messages.
  - `h`: jump to previous message or previous message group.
  - `l`: jump to next message or next message group.
  - `Enter`: close the overlay and return to prompt/INSERT mode without submitting.
  - `Esc`: remain in CHAT NAV mode, matching the requested key model.
- Remove the fallback warning about missing scroll APIs because the extension will no longer depend on undocumented Pi TUI methods.

This does not scroll Pi's built-in message pane directly. Instead, it provides a real navigable chat-history view using supported extension APIs.

## Files to modify

- `extensions/vim-chat-navigation.ts`
  - Remove `SCROLL_METHODS`, `navigateChat`, and runtime scroll probing.
  - Add a `ChatHistoryNavigator` component.
  - Wire `Esc` from the editor to open the navigator.
- Optional later documentation file:
  - `docs/vim-chat-navigation.md` or README notes explaining the key model and overlay behavior.

## Reuse

- Existing extension: `extensions/vim-chat-navigation.ts`.
- Pi custom editor pattern from `/opt/pi-coding-agent/examples/extensions/modal-editor.ts`.
- Pi overlay/custom component API from `/opt/pi-coding-agent/docs/tui.md`.
- Session history access via `ctx.sessionManager.getBranch()` documented in `/opt/pi-coding-agent/docs/extensions.md` and `/opt/pi-coding-agent/docs/session-format.md`.
- TUI helpers from `@earendil-works/pi-tui`, especially `matchesKey`, `truncateToWidth`, `wrapTextWithAnsi`, and `visibleWidth` if needed.

## Steps

- [ ] Define a `ChatHistoryItem` representation that extracts displayable messages from `ctx.sessionManager.getBranch()`.
- [ ] Add formatting helpers for user, assistant, tool result, bash, custom, compaction, and branch summary messages.
- [ ] Implement a `ChatHistoryNavigator` component with internal scroll/selection state.
- [ ] Render a header showing `CHAT NAV`, help text, and the current position.
- [ ] Render chat history lines within the overlay width/height, truncating or wrapping safely.
- [ ] Map `j/k` to line-level movement or scroll.
- [ ] Map `h/l` to previous/next message group movement.
- [ ] Map `Enter` to close the overlay and restore INSERT mode without submitting.
- [ ] Keep `Esc` sticky in CHAT NAV mode rather than closing the overlay.
- [ ] Update the custom editor so `Esc` launches the overlay instead of changing to a fake chat mode that probes missing APIs.
- [ ] Remove the missing-scroll-API status message.
- [ ] Keep a visible status/border indicator so the user knows whether they are in INSERT or CHAT NAV.

## Verification

- [ ] Start Pi with the extension loaded.
- [ ] Press `Esc` from the prompt and confirm the CHAT NAV overlay opens.
- [ ] Press `j/k` and confirm the overlay moves through history.
- [ ] Press `h/l` and confirm movement between message groups.
- [ ] Confirm `h/j/k/l` do not type into the prompt while the overlay is active.
- [ ] Press `Esc` in CHAT NAV and confirm it stays in CHAT NAV.
- [ ] Press `Enter` in CHAT NAV and confirm it closes the overlay and returns to INSERT without submitting.
- [ ] Press `Enter` in INSERT and confirm it still submits normally.
- [ ] Confirm the previous warning `message scroll API unavailable` no longer appears.
- [ ] Confirm normal Pi commands like `/tree`, `/model`, and `/quit` still work from INSERT mode.

## Constraints

- Do not run any git commands while carrying out this fix unless explicitly re-approved by the user.
- Use only supported Pi extension APIs; avoid depending on undocumented runtime methods for message-pane scrolling.
