/**
 * Vim Chat Navigation
 *
 * Adds a two-mode editor workflow for Pi:
 * - INSERT/PROMPT mode: default Pi editor behavior. Enter submits.
 * - CHAT/NAV mode: Esc from INSERT enters this mode; h/j/k/l are captured
 *   for chat navigation and never typed into the prompt; Enter returns to INSERT
 *   without submitting.
 *
 * Note: Pi's public extension API exposes custom editor replacement, but does not
 * currently document a stable message-pane scroll API. This extension probes for
 * common runtime scroll method names and otherwise safely no-ops while keeping the
 * modal key behavior intact.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type VimChatMode = "insert" | "chat";
type ChatAction = "up" | "down" | "left" | "right";

type ModeChangeHandler = (mode: VimChatMode) => void;

const SCROLL_METHODS: Record<ChatAction, readonly string[]> = {
  up: [
    "scrollMessagesUp",
    "scrollChatUp",
    "scrollHistoryUp",
    "scrollViewportUp",
    "scrollUp",
  ],
  down: [
    "scrollMessagesDown",
    "scrollChatDown",
    "scrollHistoryDown",
    "scrollViewportDown",
    "scrollDown",
  ],
  left: [
    "scrollMessagesLeft",
    "scrollChatLeft",
    "scrollHistoryLeft",
    "scrollViewportLeft",
    "scrollLeft",
  ],
  right: [
    "scrollMessagesRight",
    "scrollChatRight",
    "scrollHistoryRight",
    "scrollViewportRight",
    "scrollRight",
  ],
};

function isPrintable(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32;
}

class VimChatNavigationEditor extends CustomEditor {
  private mode: VimChatMode = "insert";
  private notifiedMissingScrollApi = false;

  constructor(
    private readonly tui: any,
    theme: any,
    keybindings: any,
    private readonly onModeChange?: ModeChangeHandler,
    private readonly onNavigationFallback?: () => void,
  ) {
    super(tui, theme, keybindings);
  }

  override handleInput(data: string): void {
    if (this.mode === "insert") {
      if (matchesKey(data, "escape")) {
        this.setMode("chat");
        return;
      }

      // Preserve Pi's default editor behavior in prompt mode, including Enter submit.
      super.handleInput(data);
      return;
    }

    // Chat/navigation mode. Escape is intentionally sticky here: only Enter returns
    // to prompt mode, so repeated Esc cannot accidentally submit or toggle back.
    if (matchesKey(data, "escape")) {
      this.setMode("chat");
      return;
    }

    if (matchesKey(data, "enter")) {
      this.setMode("insert");
      return;
    }

    if (data === "h") {
      this.navigateChat("left");
      return;
    }
    if (data === "j") {
      this.navigateChat("down");
      return;
    }
    if (data === "k") {
      this.navigateChat("up");
      return;
    }
    if (data === "l") {
      this.navigateChat("right");
      return;
    }

    // While navigating chat, printable keys should not be inserted into the prompt.
    if (isPrintable(data)) return;

    // Let Pi keep handling control/application shortcuts such as Ctrl+C, Ctrl+D,
    // Ctrl+L, model cycling, etc.
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;

    const label = this.mode === "insert" ? " INSERT " : " CHAT NAV ";
    const last = lines.length - 1;

    if (visibleWidth(lines[last]!) >= label.length) {
      lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
    }

    return lines;
  }

  private setMode(mode: VimChatMode): void {
    if (this.mode === mode) {
      this.requestRender();
      return;
    }

    this.mode = mode;
    this.onModeChange?.(mode);
    this.invalidate();
    this.requestRender();
  }

  private navigateChat(action: ChatAction): void {
    const handled = this.callFirstSupportedTuiMethod(SCROLL_METHODS[action], 3);

    if (!handled && !this.notifiedMissingScrollApi) {
      this.notifiedMissingScrollApi = true;
      this.onNavigationFallback?.();
    }

    this.requestRender();
  }

  private callFirstSupportedTuiMethod(methodNames: readonly string[], amount: number): boolean {
    for (const methodName of methodNames) {
      const method = this.tui?.[methodName];
      if (typeof method !== "function") continue;

      try {
        const result = method.call(this.tui, amount);
        return result !== false;
      } catch {
        // Try the next possible runtime method name.
      }
    }

    return false;
  }

  private requestRender(): void {
    this.tui?.requestRender?.();
  }
}

export default function(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const setModeStatus = (mode: VimChatMode) => {
      const label = mode === "insert"
        ? ctx.ui.theme.fg("accent", "mode: INSERT")
        : ctx.ui.theme.fg("warning", "mode: CHAT NAV (Enter → prompt)");
      ctx.ui.setStatus("vim-chat-navigation", label);
    };

    setModeStatus("insert");

    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimChatNavigationEditor(
        tui,
        theme,
        keybindings,
        setModeStatus,
        () => {
          ctx.ui.setStatus(
            "vim-chat-navigation",
            ctx.ui.theme.fg(
              "warning",
              "mode: CHAT NAV — h/j/k/l captured; message scroll API unavailable",
            ),
          );
        },
      ),
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("vim-chat-navigation", undefined);
    ctx.ui.setEditorComponent(undefined);
  });
}
