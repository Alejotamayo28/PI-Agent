# Plan: Add Vim-style visual selection and yank to chat navigator

## Context

The current `extensions/vim-chat-navigation.ts` provides a CHAT NAV overlay for the current session text history:

- `Esc` from prompt opens the overlay and enters `mode: NORMAL`.
- `j/k` move through the current session text history.
- `h/l` move between message groups.
- `Esc` closes the overlay and returns to `mode: INSERT`.
- `Enter` no longer closes the overlay.

The next goal is to make copying text from the overlay feel closer to Neovim:

- `V` / `Shift+v`: start visual-line selection.
- Move with `j/k` to highlight full lines.
- `v`: start visual-character selection.
- Move with `h/j/k/l` to highlight text from the starting position.
- `y`: copy/yank selected text.

## Approach

Implement selection inside the existing CHAT NAV overlay only. Do not try to control Pi's native message pane.

Recommended staged behavior:

1. Add robust visual-line mode first because the overlay is currently line-oriented.
2. Add basic visual-character mode using line/column cursor state.
3. Add clipboard copying through a small helper that uses available clipboard mechanisms.
4. Keep `Esc` Vim-like:
   - In visual mode: cancel selection and return to NORMAL.
   - In NORMAL mode: close overlay and return to INSERT.

Modes inside the overlay:

- `normal`: existing CHAT NAV movement.
- `visualLine`: line-range selection started with `V`.
- `visualChar`: character-range selection started with `v`.

Key behavior:

| Mode | Key | Behavior |
|---|---|---|
| NORMAL | `V` | start visual-line selection at current line |
| NORMAL | `v` | start visual-character selection at current line/column |
| NORMAL | `Esc` | close overlay and return to INSERT |
| VISUAL LINE | `j/k` | extend line selection |
| VISUAL LINE | `h/l` | optionally move to previous/next message group while extending selection |
| VISUAL LINE | `y` | copy selected full lines and return to NORMAL |
| VISUAL CHAR | `h/l` | move character cursor left/right and extend selection |
| VISUAL CHAR | `j/k` | move cursor down/up preserving preferred column |
| VISUAL CHAR | `y` | copy selected character range and return to NORMAL |
| VISUAL | `Esc` | cancel selection and return to NORMAL |

## Files to modify

- `extensions/vim-chat-navigation.ts`
  - Add visual selection state to `ChatHistoryNavigator`.
  - Render highlighted selected lines/ranges.
  - Add yank/copy logic.
  - Update overlay help text.

Optional if clipboard support requires it:

- Add a small local helper in the same file for clipboard fallback commands.

## Reuse

- Existing `ChatHistoryNavigator` state and rendered line model in `extensions/vim-chat-navigation.ts`.
- Existing `matchesKey`, `truncateToWidth`, and `visibleWidth` imports from `@earendil-works/pi-tui`.
- Clipboard options found in installed Pi dependency:
  - `/opt/pi-coding-agent/node_modules/@mariozechner/clipboard/index.d.ts`
  - Methods include `setText(text: string): Promise<void>`.
- Fallback terminal/OS clipboard commands if needed:
  - `wl-copy`
  - `xclip` / `xsel`
  - `pbcopy`
  - `termux-clipboard-set`

## Steps

- [ ] Add overlay mode state: `normal`, `visualLine`, and `visualChar`.
- [ ] Add cursor/selection state: anchor line, cursor line, anchor column, cursor column, and preferred column.
- [ ] Update `V` to enter visual-line mode from the current selected line.
- [ ] Update `v` to enter visual-character mode from the current selected line/column.
- [ ] Make `Esc` cancel visual selection when in visual mode, but close overlay when already in normal mode.
- [ ] Make `j/k` extend visual-line selections across full rendered lines.
- [ ] Make `h/l/j/k` extend visual-character selection using line/column cursor movement.
- [ ] Render selected line ranges with the selected background.
- [ ] Render visual-character ranges with selected background for selected substrings where practical.
- [ ] Implement `getSelectedText()` for both visual modes.
- [ ] Implement `copyText()` using `@mariozechner/clipboard.setText()` with command fallbacks if import fails.
- [ ] Bind `y` in visual modes to copy the selected text, return to normal mode, and show a status/notification.
- [ ] Update the overlay header/help text to show `V line select`, `v char select`, `y yank`, and `Esc cancel/close`.

## Verification

- [ ] Open Pi and press `Esc` to enter `mode: NORMAL`.
- [ ] Press `V`, move with `j/k`, and confirm full lines are highlighted.
- [ ] Press `y` and confirm the highlighted lines are copied to the system clipboard.
- [ ] Press `v`, move with `h/j/k/l`, and confirm a character range is highlighted.
- [ ] Press `y` and confirm the highlighted character range is copied.
- [ ] In visual mode, press `Esc` and confirm it cancels selection but keeps the overlay open in NORMAL mode.
- [ ] In normal mode, press `Esc` and confirm it closes the overlay and returns to `mode: INSERT`.
- [ ] Confirm `Enter` still does not close the overlay.
- [ ] Confirm `j/k/h/l` still navigate normally outside visual mode.

## Constraints

- Do not run git commands unless explicitly approved again by the user.
- Keep the implementation scoped to the CHAT NAV overlay.
- Prefer line selection as the first reliable implementation; character selection can be basic and improved later.
