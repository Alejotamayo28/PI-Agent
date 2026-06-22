# Plan: Ask Agent About Selected Transcript Text

## Context

The vim chat navigator already supports visual selection and yanking selected transcript text with `y`. The new feature should make the transcript interactive: select text/code in navigation mode, press `?`, and send that selection back to the agent with an explanation prompt.

Desired workflow:

```text
Esc      open chat navigator
V / v    select transcript text
?        ask the agent to explain the selected text/code
```

Example generated prompt:

````text
Explain this selected text/code:

```text
<selected transcript text>
```
````

## Example

Starting transcript in the navigator:

```text
────────────────────────── AGENT RESULT ─────────────────────────
π ASSISTANT · gpt-5.5 08:10 PM
  function getSectionSeparatorLabel(item, previousItem) {
    if (item.role === "user") return "PROMPT";
    if (!previousItem || previousItem.role === "user") return "AGENT RESULT";
    return undefined;
  }
```

User selects these lines with `V`:

```text
  function getSectionSeparatorLabel(item, previousItem) {
    if (item.role === "user") return "PROMPT";
    if (!previousItem || previousItem.role === "user") return "AGENT RESULT";
    return undefined;
  }
```

Then presses `?`. The extension sends this prompt:

````text
Explain this selected text/code:

```text
function getSectionSeparatorLabel(item, previousItem) {
  if (item.role === "user") return "PROMPT";
  if (!previousItem || previousItem.role === "user") return "AGENT RESULT";
  return undefined;
}
```
````

Expected result in the main chat:

```text
 USER
  Explain this selected text/code:
  ...selected code...

π ASSISTANT
  This function decides which section divider to show in the chat navigator...
```

## Approach

Reuse the existing visual selection pipeline. Add a new callback to `ChatHistoryNavigator` for asking about selected text, similar to the current yank callback.

Recommended behavior:

- `?` only acts in `visualLine` or `visualChar` mode.
- If there is no selected text, cancel visual mode and notify nothing or show a small warning.
- If selected text exists, close/cancel visual mode and send a prompt to the agent.
- The first implementation uses one fixed prompt: `Explain this selected text/code:`.
- Wrap selected text in a fenced code block so formatting is preserved.
- After submitting, close the overlay and return to INSERT mode so the agent response appears in the normal chat flow.

## Files to modify

- `extensions/vim-chat-navigation.ts`

## Reuse

Existing code to reuse:

- `ChatHistoryNavigator.handleVisualInput` for handling visual-mode keys.
- `ChatHistoryNavigator.getSelectedText` for obtaining visual-line and visual-char selections.
- `ChatHistoryNavigator.yankSelection` as the model for selection-based actions.
- Existing `onYank` callback pattern in the navigator constructor.
- `ctx.ui.notify` for user feedback.
- Existing overlay close flow via `done()` / `returnToInsert`.

## Steps

- [x] Add an `AskSelectionHandler` type, similar to `YankHandler`.
- [x] Add an `onAskSelection` callback to `ChatHistoryNavigator` constructor.
- [x] Add `?` handling in `handleVisualInput` before printable-key ignoring.
- [x] Implement `askSelection()` using `getSelectedText`, mirroring `yankSelection` behavior.
- [x] Add a prompt formatter helper that creates `Explain this selected text/code:` plus a fenced `text` block.
- [x] Wire the callback in `openChatNavigator` so selected text is sent to the agent.
- [x] Use the best available Pi API for sending a user prompt from an extension; if the API needs discovery, inspect installed type definitions or runtime context first during implementation.
- [x] After successful send, close the overlay and return to insert mode.
- [x] Notify success/failure with `ctx.ui.notify`.
- [x] Update the overlay header help text to mention `? ask`.
- [x] Ensure `y` yank behavior remains unchanged.
- [x] Ensure `?` does nothing in normal navigation mode except remain ignored as a printable key.

## Verification

Manual checks in TUI:

- [x] Open navigator with `Esc`.
- [x] Select one or more lines with `V`, press `?`, and confirm an explanation prompt is sent.
- [x] Select characters with `v`, press `?`, and confirm only the selected characters are sent.
- [x] Confirm the overlay closes and mode returns to INSERT after sending.
- [x] Confirm the agent responds to the selected text/code.
- [x] Confirm pressing `?` in normal navigation mode does not type into the prompt or trigger a send.
- [x] Confirm pressing `y` still yanks to clipboard.
- [x] Confirm empty selections do not send an empty prompt.
- [x] Confirm selected text from collapsed and expanded tool accordion rows is handled correctly.

## Future follow-ups

- Add prompt variants such as explain, refactor, find bugs, or write tests.
- Allow configuring the prompt prefix.
- Add a small chooser overlay for multiple actions instead of binding only `?`.
