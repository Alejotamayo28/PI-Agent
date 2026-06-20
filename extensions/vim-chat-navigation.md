# Vim Chat Navigation Extension

`vim-chat-navigation.ts` adds a Vim-like navigation overlay for Pi session transcripts.

## Goal

Pi does not currently have a built-in shortcut to switch focus from the prompt editor into the session chat. This extension provides that workflow by opening a focused transcript overlay when the user presses `Esc` while Pi is idle.

The overlay is intended to be a readable source-of-truth transcript for the text Pi shows in chat history: normal messages, thinking text, tool-call text, tool results, bash execution output, custom message text, summaries, and image placeholders.

## How It Works

- In normal prompt/insert mode, Pi behaves normally.
- When Pi is idle, pressing `Esc` opens the session transcript overlay.
- While the overlay is open, navigation keys are captured by the overlay and do not type into the prompt.
- Pressing `Esc` in the overlay closes it and returns to prompt mode.
- If Pi is not idle, `Esc` is passed through to Pi so abort/cancel behavior is preserved.

## Keybindings

| Key | Behavior |
|---|---|
| `Esc` in prompt | Open transcript overlay, only while idle |
| `Esc` in overlay | Close overlay, or exit visual mode |
| `j` | Move down one rendered line |
| `k` | Move up one rendered line |
| `h` | Jump to previous transcript item |
| `l` | Jump to next transcript item |
| `V` | Start visual line selection |
| `v` | Start visual character selection |
| `y` | Yank selected plain text to clipboard |

## Transcript Content

The overlay currently attempts to show the readable chat transcript content from the active branch:

- User messages
- Assistant messages
- Assistant thinking blocks, labeled as `[thinking]`
- Assistant tool calls, labeled as `[tool call]` with full command/arguments as plain text
- Tool result output text
- Bash execution command/output from `!` and `!!`
- Custom message text from extensions, including hidden/display-false entries when they have content
- Branch and compaction summary text
- Unknown message roles only when they have readable text-like content
- Image content as placeholders, for example `[image: image/png]`

## Formatting

The extension keeps two versions of rendered content:

- `rawText` — clean plain text used for visual selection and yank.
- `displayText` — styled text used for terminal rendering.

This is important because visual selection and clipboard output should not include ANSI escape codes.

Markdown-like content receives lightweight styling for:

- headings
- lists
- block quotes
- horizontal rules
- code fences
- inline code
- links
- bold text

This is not yet a full Markdown renderer. It is a lightweight terminal-friendly formatter.

## Testing Manually

Start Pi with the extension:

```bash
pi -e ./extensions/vim-chat-navigation.ts
```

Then test these flows:

1. Send a Markdown-style prompt, for example:

   ```text
   # Heading
   Please answer with **bold text** and `inline code`.
   ```

2. Trigger a tool call, for example ask:

   ```text
   Read extensions/vim-chat-navigation.ts and summarize it.
   ```

3. Run a local bash execution:

   ```text
   !!echo vimnav-bash-test
   ```

4. Wait until Pi is idle.

5. Press `Esc`.

Expected result:

- A transcript overlay opens.
- User, assistant, tool result, bash, custom, thinking, tool call, image, and summary content appears as plain text when present.
- Session metadata like `id`, `parentId`, `timestamp`, raw `type`, and `[source entry]` should not appear in message bodies.
- `j/k/h/l` navigate without typing into the prompt.
- `V` or `v` starts selection.
- `y` copies selected plain text without ANSI codes.
- `Esc` closes the overlay and returns to insert/prompt mode.

## Known Notes

- The overlay is a snapshot of the session when opened; it does not live-update while open.
- Content is intentionally not collapsed/truncated by this extension right now, because the overlay is being treated as the source-of-truth transcript.
- Future improvements may add smarter collapsing/truncation strategies without losing access to the full raw content.
- Because the overlay is centered and rendered over existing chat, raw terminal logs or stripped ANSI captures can look broken. Always judge formatting inside a real terminal, inside the overlay border.
