# Plan: Neovim-style Pi chat navigation extension

## Context

We want Pi to support a Neovim-like interaction model for the interactive chat UI:

- Keep `Enter` working normally in the prompt/editor so it still submits messages.
- Add a way to leave the prompt and navigate chat history with `h/j/k/l`.
- Add a way to return to the prompt and start typing again without accidentally submitting.
- Implement this as a Pi extension stored in this Git-backed Pi config repository (`~/.pi/agent`, remote `Alejotamayo28/PI-Agent`).

Current findings:

- This repository already stores global Pi extensions under `extensions/`.
- Existing extensions follow a simple single-file TypeScript pattern and import `ExtensionAPI` from `@earendil-works/pi-coding-agent`.
- Pi has an example modal editor at `/opt/pi-coding-agent/examples/extensions/modal-editor.ts` using `CustomEditor` and `ctx.ui.setEditorComponent(...)`.
- Simple `keybindings.json` is not enough for plain `h/j/k/l`, because those keys must remain normal text while typing.

## Approach

Implement a global extension that replaces Pi's editor component with a custom modal editor. The first version will focus on safe prompt-mode behavior plus a chat/navigation mode state machine.

Recommended key model:

- Prompt/insert mode:
  - `Enter`: submit prompt exactly as Pi does by default.
  - `Esc`: switch to chat-history/navigation mode.
- Chat/navigation mode:
  - `j` / `k`: navigate or scroll chat history if Pi's TUI APIs expose a supported method; otherwise maintain visible mode state and fall back to terminal scrollback until a deeper TUI hook is available.
  - `h` / `l`: reserved for future branch/message navigation or horizontal movement.
  - `Enter`: return to prompt/insert mode; does **not** submit.
  - `Esc`: stays in chat/navigation mode; it is the dedicated key for leaving prompt mode.
  - Control keys such as `Ctrl+C`, `Ctrl+D`, model shortcuts, etc. pass through to Pi's default handling.

Because Pi's public extension docs clearly expose custom editor replacement but do not clearly expose direct scroll control for the built-in message pane, implementation should be staged:

1. Build the modal editor safely.
2. Verify whether the runtime `tui` object provides message scroll APIs.
3. If no supported API exists, keep chat mode as a foundation and document that true history-pane scrolling requires either terminal scrollback or a deeper Pi TUI API/patch.

## Files to modify

- `extensions/vim-chat-navigation.ts` — new extension.
- `settings.json` — add the new extension to the `extensions` array if auto-discovery/settings loading does not pick it up automatically.
- `README.md` or `docs/vim-chat-navigation.md` — optional usage notes for the GitHub repository.

## Reuse

- `/opt/pi-coding-agent/examples/extensions/modal-editor.ts` — reuse the `CustomEditor` + `ctx.ui.setEditorComponent(...)` modal editor pattern.
- `/opt/pi-coding-agent/docs/tui.md` — reuse documented custom editor guidance and key handling rules.
- Existing local extension style:
  - `extensions/skill-model-router.ts`
  - `extensions/omarchy-system-theme.ts`

## Steps

- [ ] Create `extensions/vim-chat-navigation.ts` based on Pi's modal editor pattern.
- [ ] Define modes: `insert`/prompt mode and `chat`/navigation mode.
- [ ] Preserve default prompt behavior by delegating `Enter` to `CustomEditor` only in insert mode.
- [ ] In insert mode, map `Esc` to chat/navigation mode instead of aborting.
- [ ] In chat mode, map only `Enter` back to insert mode without submitting.
- [ ] In chat mode, handle `h/j/k/l` for chat navigation if a supported TUI scroll/navigation API is available.
- [ ] Pass unhandled control keys through to `super.handleInput(data)` so Pi shortcuts keep working.
- [ ] Add a visible mode indicator to the editor border/status so the user knows whether they are typing or navigating.
- [ ] Register/load the extension globally and run `/reload` or restart Pi.
- [ ] Commit and push the extension to the GitHub repository after verification.

## Verification

- [ ] Start Pi with the extension loaded.
- [ ] In prompt mode, type text and confirm normal letters appear.
- [ ] Press `Enter` in prompt mode and confirm it submits exactly like default Pi.
- [ ] Press `Esc` and confirm the mode indicator changes to chat/navigation mode.
- [ ] Press `j/k/h/l` in chat mode and confirm they do not type into the prompt.
- [ ] Press `Enter` in chat mode and confirm it returns to prompt mode without submitting.
- [ ] Press `Esc` in chat mode and confirm it remains in chat/navigation mode rather than returning to prompt mode.
- [ ] Confirm `Ctrl+C`, `Ctrl+D`, `/tree`, `/model`, and normal Pi shortcuts still work.
- [ ] If TUI scroll APIs are available, confirm `j/k` move through chat history; if not, document the limitation and fallback.
