/**
 * Vim Chat Navigation
 *
 * Adds a two-mode workflow for Pi:
 * - INSERT/PROMPT mode: default Pi editor behavior. Enter submits.
 * - CHAT NAV mode: Esc opens a focused overlay with current session history;
 *   h/j/k/l navigate there and never type into the prompt; Esc closes the
 *   overlay and returns to INSERT without submitting.
 */

import { spawn } from "node:child_process";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type VimChatMode = "insert" | "chat";
type MessageRole = "user" | "assistant";
type NavigatorMode = "normal" | "visualLine" | "visualChar";

interface ChatHistoryItem {
  id: string;
  role: MessageRole;
  title: string;
  body: string;
}

interface RenderedLine {
  itemIndex: number;
  text: string;
  kind: "separator" | "title" | "body";
}

interface TextRange {
  start: number;
  end: number;
}

type ModeChangeHandler = (mode: VimChatMode) => void;
type OpenChatNavigator = () => void;
type IsIdleHandler = () => boolean;
type YankHandler = (text: string) => void | Promise<void>;

const MAX_BODY_CHARS = 8_000;
const DEFAULT_VISIBLE_HISTORY_LINES = 20;

function isPrintable(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32;
}

function cleanText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trimEnd();
}

function truncateBody(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}\n… [truncated for chat navigator]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateInline(text: string, maxChars = 160): string {
  const cleaned = cleanText(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

function stringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? cleanText(value).trim() : "";
}

function numberArgument(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatPathWithRange(path: string, args: Record<string, unknown>): string {
  const offset = numberArgument(args, "offset");
  const limit = numberArgument(args, "limit");
  if (offset !== undefined && limit !== undefined) return `${path}:${offset}-${offset + limit - 1}`;
  if (offset !== undefined) return `${path}:${offset}`;
  if (limit !== undefined) return `${path}:1-${limit}`;
  return path;
}

function compactJson(value: unknown): string {
  try {
    return truncateInline(JSON.stringify(value));
  } catch {
    return truncateInline(String(value));
  }
}

function formatThinkingBlock(block: Record<string, unknown>): string {
  return cleanText(block.thinking);
}

function formatToolCallBlock(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" && block.name.trim() ? block.name.trim() : "toolCall";
  const args = isRecord(block.arguments) ? block.arguments : undefined;
  if (!args) return name;

  const path = stringArgument(args, "path");
  const pattern = stringArgument(args, "pattern");
  const query = stringArgument(args, "query");
  const command = stringArgument(args, "command");

  switch (name) {
    case "read":
      return path ? `read ${formatPathWithRange(path, args)}` : "read";
    case "write":
      return path ? `write ${path}` : "write";
    case "edit":
      return path ? `edit ${path}` : "edit";
    case "bash":
      return command ? `bash ${truncateInline(command.split("\n")[0] ?? "")}` : "bash";
    case "grep":
      return truncateInline(["grep", pattern, path].filter(Boolean).join(" ")) || "grep";
    case "find":
      return truncateInline(["find", pattern || query, path].filter(Boolean).join(" ")) || "find";
    case "ls":
      return path ? `ls ${path}` : "ls";
    case "web_search":
      return query ? `web_search ${truncateInline(query)}` : "web_search";
    case "fetch_content": {
      const url = stringArgument(args, "url");
      return url ? `fetch_content ${truncateInline(url)}` : "fetch_content";
    }
    default:
      return `${name} ${compactJson(args)}`.trim();
  }
}

function contentToDisplayText(content: unknown): string {
  if (typeof content === "string") return cleanText(content);
  if (!Array.isArray(content)) return cleanText(content);

  const parts = content.map((block) => {
    if (!isRecord(block)) return "";

    switch (block.type) {
      case "text":
        return cleanText(block.text);
      case "thinking":
        return formatThinkingBlock(block);
      case "toolCall":
        return formatToolCallBlock(block);
      default:
        return "";
    }
  });

  return cleanText(parts.filter(Boolean).join("\n\n"));
}

function formatTimestamp(message: Record<string, any>, entry: Record<string, any>): string {
  const raw = message.timestamp ?? entry.timestamp;
  if (!raw) return "";

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function titleWithTime(label: string, time: string): string {
  return time ? `${label} ${time}` : label;
}

function formatUserMessage(message: Record<string, any>, entry: Record<string, any>): ChatHistoryItem {
  return {
    id: entry.id ?? `user-${entry.timestamp ?? Math.random()}`,
    role: "user",
    title: titleWithTime("USER", formatTimestamp(message, entry)),
    body: truncateBody(contentToDisplayText(message.content) || "[empty user message]"),
  };
}

function formatAssistantMessage(message: Record<string, any>, entry: Record<string, any>): ChatHistoryItem | undefined {
  const body = contentToDisplayText(message.content);
  if (!body.trim()) return undefined;

  const model = message.model ? ` · ${message.model}` : "";
  return {
    id: entry.id ?? `assistant-${entry.timestamp ?? Math.random()}`,
    role: "assistant",
    title: titleWithTime(`ASSISTANT${model}`, formatTimestamp(message, entry)),
    body: truncateBody(body),
  };
}

function formatMessageEntry(entry: Record<string, any>): ChatHistoryItem | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
    return undefined;
  }

  const message = entry.message as Record<string, any>;
  switch (message.role) {
    case "user":
      return formatUserMessage(message, entry);
    case "assistant":
      return formatAssistantMessage(message, entry);
    default:
      return undefined;
  }
}

function getChatHistoryItems(branchEntries: readonly unknown[]): ChatHistoryItem[] {
  return branchEntries
    .map((entry) => formatMessageEntry((entry ?? {}) as Record<string, any>))
    .filter((item): item is ChatHistoryItem => Boolean(item));
}

function wrapPlainLine(text: string, width: number): string[] {
  if (width <= 0) return [""];
  if (visibleWidth(text) <= width) return [text];

  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!word) continue;
    if (visibleWidth(current + word) <= width) {
      current += word;
      continue;
    }

    if (current.trim()) {
      lines.push(current.trimEnd());
      current = "";
    }

    if (visibleWidth(word) <= width) {
      current = word.trimStart();
      continue;
    }

    let rest = word;
    while (visibleWidth(rest) > width) {
      lines.push(truncateToWidth(rest, width, ""));
      rest = rest.slice(lines[lines.length - 1]!.length);
    }
    current = rest;
  }

  if (current.trim()) lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [""];
}

function wrapPlainText(text: string, width: number): string[] {
  const rawLines = cleanText(text).split("\n");
  const wrapped = rawLines.flatMap((line) => wrapPlainLine(line || " ", width));
  return wrapped.length > 0 ? wrapped : [" "];
}

function textChars(text: string): string[] {
  return Array.from(text);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function comparePosition(aLine: number, aColumn: number, bLine: number, bColumn: number): number {
  if (aLine !== bLine) return aLine - bLine;
  return aColumn - bColumn;
}

function runClipboardCommand(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
    child.stdin.end(text);
  });
}

async function copyText(text: string): Promise<void> {
  try {
    const clipboard = await import("@mariozechner/clipboard");
    if (typeof clipboard.setText === "function") {
      await clipboard.setText(text);
      return;
    }
  } catch {
    // Fall back to platform clipboard commands below.
  }

  const commands: Array<[string, string[]]> = [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
    ["pbcopy", []],
    ["termux-clipboard-set", []],
    ["clip.exe", []],
  ];

  let lastError: unknown;
  for (const [command, args] of commands) {
    try {
      await runClipboardCommand(command, args, text);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("No clipboard command succeeded");
}

class ChatHistoryNavigator {
  private mode: NavigatorMode = "normal";
  private selectedLine = Number.MAX_SAFE_INTEGER;
  private scrollTop = 0;
  private cachedWidth?: number;
  private cachedLines?: RenderedLine[];
  private anchorLine = 0;
  private cursorLine = 0;
  private anchorColumn = 0;
  private cursorColumn = 0;
  private preferredColumn = 0;

  constructor(
    private readonly items: ChatHistoryItem[],
    private readonly tui: any,
    private readonly theme: any,
    private readonly onClose: () => void,
    private readonly onYank: YankHandler,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.mode === "normal") {
        this.onClose();
      } else {
        this.cancelVisualMode();
      }
      return;
    }

    if (matchesKey(data, "enter")) {
      this.requestRender();
      return;
    }

    if (this.mode === "normal") {
      this.handleNormalInput(data);
      return;
    }

    this.handleVisualInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const contentWidth = Math.max(10, safeWidth - 4);
    const historyLines = this.getRenderedLines(contentWidth);
    const visibleCount = DEFAULT_VISIBLE_HISTORY_LINES;
    this.clampSelection(historyLines.length);
    this.ensureVisualStateInBounds(historyLines.length);
    this.ensureSelectionVisible(visibleCount, historyLines.length);

    const selectedItem = historyLines[this.selectedLine]?.itemIndex ?? 0;
    const header = this.theme.fg("accent", ` ${this.modeLabel()} `) + this.theme.fg(
      "muted",
      `current session text • j/k move • V line select • v char select • y yank • Esc cancel/close`,
    );
    const position = this.theme.fg(
      "dim",
      ` line ${Math.min(this.selectedLine + 1, historyLines.length)}/${Math.max(historyLines.length, 1)} · message ${Math.min(selectedItem + 1, this.items.length)}/${Math.max(this.items.length, 1)}`,
    );

    const lines: string[] = [
      this.border(safeWidth, "top"),
      this.padLine(header, safeWidth),
      this.padLine(position, safeWidth),
      this.border(safeWidth, "middle"),
    ];

    if (this.items.length === 0) {
      lines.push(this.padLine(this.theme.fg("muted", "No text chat history yet."), safeWidth));
    } else {
      const visible = historyLines.slice(this.scrollTop, this.scrollTop + visibleCount);
      for (let i = 0; i < visibleCount; i++) {
        const line = visible[i];
        const globalIndex = this.scrollTop + i;
        if (!line) {
          lines.push(this.padLine("", safeWidth));
          continue;
        }

        if (line.kind === "separator") {
          const separator = this.theme.fg("borderMuted", "─".repeat(Math.max(0, safeWidth - 2)));
          lines.push(this.padLine(separator, safeWidth));
          continue;
        }

        const marker = globalIndex === this.selectedLine ? "▶ " : "  ";
        const renderedText = this.renderHistoryLine(globalIndex, line.text);
        const text = truncateToWidth(`${marker}${renderedText}`, safeWidth - 2, "…");
        const shouldHighlightWholeLine = this.mode === "normal" && globalIndex === this.selectedLine;
        lines.push(
          shouldHighlightWholeLine
            ? this.padLine(this.theme.bg("selectedBg", text), safeWidth)
            : this.padLine(text, safeWidth),
        );
      }
    }

    lines.push(this.border(safeWidth, "bottom"));
    return lines.map((line) => truncateToWidth(line, safeWidth, ""));
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private handleNormalInput(data: string): void {
    if (data === "V") {
      this.enterVisualLineMode();
      return;
    }
    if (data === "v") {
      this.enterVisualCharMode();
      return;
    }
    if (data === "j") {
      this.moveLine(1);
      return;
    }
    if (data === "k") {
      this.moveLine(-1);
      return;
    }
    if (data === "h") {
      this.moveGroup(-1);
      return;
    }
    if (data === "l") {
      this.moveGroup(1);
      return;
    }

    if (isPrintable(data)) return;
  }

  private handleVisualInput(data: string): void {
    if (data === "y") {
      void this.yankSelection();
      return;
    }

    if (this.mode === "visualLine") {
      if (data === "j") {
        this.moveVisualLine(1);
        return;
      }
      if (data === "k") {
        this.moveVisualLine(-1);
        return;
      }
      if (data === "h") {
        this.moveVisualGroup(-1);
        return;
      }
      if (data === "l") {
        this.moveVisualGroup(1);
        return;
      }
    }

    if (this.mode === "visualChar") {
      if (data === "h") {
        this.moveVisualCharHorizontal(-1);
        return;
      }
      if (data === "l") {
        this.moveVisualCharHorizontal(1);
        return;
      }
      if (data === "j") {
        this.moveVisualCharLine(1);
        return;
      }
      if (data === "k") {
        this.moveVisualCharLine(-1);
        return;
      }
    }

    if (isPrintable(data)) return;
  }

  private enterVisualLineMode(): void {
    this.mode = "visualLine";
    this.anchorLine = this.selectedLine;
    this.cursorLine = this.selectedLine;
    this.anchorColumn = 0;
    this.cursorColumn = 0;
    this.preferredColumn = 0;
    this.requestRender();
  }

  private enterVisualCharMode(): void {
    this.mode = "visualChar";
    this.anchorLine = this.selectedLine;
    this.cursorLine = this.selectedLine;
    this.anchorColumn = this.clampColumn(this.selectedLine, this.cursorColumn);
    this.cursorColumn = this.anchorColumn;
    this.preferredColumn = this.cursorColumn;
    this.requestRender();
  }

  private cancelVisualMode(): void {
    this.mode = "normal";
    this.requestRender();
  }

  private async yankSelection(): Promise<void> {
    const text = this.getSelectedText();
    if (!text) {
      this.cancelVisualMode();
      return;
    }

    await this.onYank(text);
    this.mode = "normal";
    this.requestRender();
  }

  private getSelectedText(): string {
    const lines = this.getRenderedLines(this.cachedWidth ?? 80);
    if (this.mode === "visualLine") {
      const [start, end] = this.getOrderedLineRange();
      return lines.slice(start, end + 1).map((line) => line.text).join("\n");
    }

    if (this.mode !== "visualChar") return "";

    const [startLine, endLine] = this.getOrderedLineRange();
    const selected: string[] = [];
    for (let lineIndex = startLine; lineIndex <= endLine; lineIndex++) {
      const text = lines[lineIndex]?.text ?? "";
      const range = this.getVisualCharRangeForLine(lineIndex, text);
      if (!range) {
        selected.push("");
        continue;
      }
      const chars = textChars(text);
      selected.push(chars.slice(range.start, range.end).join(""));
    }
    return selected.join("\n");
  }

  private getRenderedLines(width: number): RenderedLine[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const lines: RenderedLine[] = [];
    this.items.forEach((item, itemIndex) => {
      lines.push({ itemIndex, text: "", kind: "separator" });
      lines.push({
        itemIndex,
        text: this.formatTitle(item),
        kind: "title",
      });

      const bodyWidth = Math.max(1, width - 2);
      for (const bodyLine of wrapPlainText(item.body, bodyWidth)) {
        lines.push({ itemIndex, text: `  ${bodyLine}`, kind: "body" });
      }
    });

    this.cachedWidth = width;
    this.cachedLines = lines.length > 0 ? lines : [{ itemIndex: 0, text: "No text chat history yet.", kind: "body" }];
    return this.cachedLines;
  }

  private formatTitle(item: ChatHistoryItem): string {
    const icon = {
      user: "",
      assistant: "π",
    }[item.role];
    return `${icon} ${item.title}`;
  }

  private modeLabel(): string {
    switch (this.mode) {
      case "visualLine":
        return "VISUAL LINE";
      case "visualChar":
        return "VISUAL";
      default:
        return "NAVIGATION";
    }
  }

  private moveLine(delta: number): void {
    const total = this.getRenderedLines(this.cachedWidth ?? 80).length;
    this.selectedLine = Math.max(0, Math.min(total - 1, this.selectedLine + delta));
    this.cursorLine = this.selectedLine;
    this.requestRender();
  }

  private moveGroup(delta: number): void {
    const lines = this.getRenderedLines(this.cachedWidth ?? 80);
    const currentItem = lines[this.selectedLine]?.itemIndex ?? 0;
    const targetItem = Math.max(0, Math.min(this.items.length - 1, currentItem + delta));
    const targetLine = this.findItemTitleLine(lines, targetItem);
    if (targetLine >= 0) {
      this.selectedLine = targetLine;
      this.cursorLine = this.selectedLine;
    }
    this.requestRender();
  }

  private moveVisualLine(delta: number): void {
    const total = this.getRenderedLines(this.cachedWidth ?? 80).length;
    this.selectedLine = Math.max(0, Math.min(total - 1, this.selectedLine + delta));
    this.cursorLine = this.selectedLine;
    this.requestRender();
  }

  private moveVisualGroup(delta: number): void {
    const lines = this.getRenderedLines(this.cachedWidth ?? 80);
    const currentItem = lines[this.selectedLine]?.itemIndex ?? 0;
    const targetItem = Math.max(0, Math.min(this.items.length - 1, currentItem + delta));
    const targetLine = this.findItemTitleLine(lines, targetItem);
    if (targetLine >= 0) {
      this.selectedLine = targetLine;
      this.cursorLine = this.selectedLine;
    }
    this.requestRender();
  }

  private moveVisualCharHorizontal(delta: number): void {
    const lines = this.getRenderedLines(this.cachedWidth ?? 80);
    if (lines.length === 0) return;

    let nextLine = this.cursorLine;
    let nextColumn = this.cursorColumn + delta;
    if (delta < 0 && nextColumn < 0 && nextLine > 0) {
      nextLine--;
      nextColumn = this.maxColumnForLine(nextLine);
    } else if (delta > 0 && nextColumn > this.maxColumnForLine(nextLine) && nextLine < lines.length - 1) {
      nextLine++;
      nextColumn = 0;
    }

    this.cursorLine = clamp(nextLine, 0, lines.length - 1);
    this.cursorColumn = this.clampColumn(this.cursorLine, nextColumn);
    this.preferredColumn = this.cursorColumn;
    this.selectedLine = this.cursorLine;
    this.requestRender();
  }

  private moveVisualCharLine(delta: number): void {
    const lines = this.getRenderedLines(this.cachedWidth ?? 80);
    if (lines.length === 0) return;

    this.cursorLine = clamp(this.cursorLine + delta, 0, lines.length - 1);
    this.cursorColumn = this.clampColumn(this.cursorLine, this.preferredColumn);
    this.selectedLine = this.cursorLine;
    this.requestRender();
  }

  private renderHistoryLine(lineIndex: number, text: string): string {
    if (this.mode === "visualLine" && this.isLineInVisualLineRange(lineIndex)) {
      return this.theme.bg("selectedBg", text || " ");
    }

    if (this.mode === "visualChar") {
      const range = this.getVisualCharRangeForLine(lineIndex, text);
      if (range) return this.applyRangeBackground(text, range);
    }

    return text;
  }

  private getOrderedLineRange(): [number, number] {
    return this.anchorLine <= this.cursorLine
      ? [this.anchorLine, this.cursorLine]
      : [this.cursorLine, this.anchorLine];
  }

  private isLineInVisualLineRange(lineIndex: number): boolean {
    const [start, end] = this.getOrderedLineRange();
    return lineIndex >= start && lineIndex <= end;
  }

  private getVisualCharRangeForLine(lineIndex: number, text: string): TextRange | undefined {
    if (this.mode !== "visualChar") return undefined;

    const anchorBeforeCursor = comparePosition(
      this.anchorLine,
      this.anchorColumn,
      this.cursorLine,
      this.cursorColumn,
    ) <= 0;
    const startLine = anchorBeforeCursor ? this.anchorLine : this.cursorLine;
    const startColumn = anchorBeforeCursor ? this.anchorColumn : this.cursorColumn;
    const endLine = anchorBeforeCursor ? this.cursorLine : this.anchorLine;
    const endColumn = anchorBeforeCursor ? this.cursorColumn : this.anchorColumn;

    if (lineIndex < startLine || lineIndex > endLine) return undefined;

    const length = textChars(text).length;
    if (length === 0) return undefined;

    const start = lineIndex === startLine ? clamp(startColumn, 0, length - 1) : 0;
    const endInclusive = lineIndex === endLine ? clamp(endColumn, 0, length - 1) : length - 1;
    const end = clamp(endInclusive + 1, start + 1, length);
    return { start, end };
  }

  private applyRangeBackground(text: string, range: TextRange): string {
    const chars = textChars(text);
    const before = chars.slice(0, range.start).join("");
    const selected = chars.slice(range.start, range.end).join("");
    const after = chars.slice(range.end).join("");
    return before + this.theme.bg("selectedBg", selected || " ") + after;
  }

  private clampSelection(totalLines: number): void {
    this.selectedLine = Math.max(0, Math.min(Math.max(totalLines - 1, 0), this.selectedLine));
  }

  private ensureVisualStateInBounds(totalLines: number): void {
    if (totalLines <= 0) return;
    this.anchorLine = clamp(this.anchorLine, 0, totalLines - 1);
    this.cursorLine = clamp(this.cursorLine, 0, totalLines - 1);
    this.cursorColumn = this.clampColumn(this.cursorLine, this.cursorColumn);
    this.anchorColumn = this.clampColumn(this.anchorLine, this.anchorColumn);
  }

  private ensureSelectionVisible(visibleCount: number, totalLines: number): void {
    if (this.selectedLine < this.scrollTop) this.scrollTop = this.selectedLine;
    if (this.selectedLine >= this.scrollTop + visibleCount) {
      this.scrollTop = this.selectedLine - visibleCount + 1;
    }
    this.scrollTop = Math.max(0, Math.min(Math.max(totalLines - visibleCount, 0), this.scrollTop));
  }

  private findItemTitleLine(lines: RenderedLine[], itemIndex: number): number {
    const titleLine = lines.findIndex((line) => line.itemIndex === itemIndex && line.kind === "title");
    return titleLine >= 0 ? titleLine : lines.findIndex((line) => line.itemIndex === itemIndex);
  }

  private maxColumnForLine(lineIndex: number): number {
    const lines = this.getRenderedLines(this.cachedWidth ?? 80);
    const text = lines[lineIndex]?.text ?? "";
    return Math.max(0, textChars(text).length - 1);
  }

  private clampColumn(lineIndex: number, column: number): number {
    return clamp(column, 0, this.maxColumnForLine(lineIndex));
  }

  private border(width: number, position: "top" | "middle" | "bottom"): string {
    const chars = position === "top"
      ? ["╭", "─", "╮"]
      : position === "bottom"
        ? ["╰", "─", "╯"]
        : ["├", "─", "┤"];
    return this.theme.fg("borderAccent", chars[0] + chars[1].repeat(Math.max(0, width - 2)) + chars[2]);
  }

  private padLine(text: string, width: number): string {
    const innerWidth = Math.max(0, width - 2);
    const truncated = truncateToWidth(text, innerWidth, "…");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
    return this.theme.fg("borderAccent", "│") + truncated + padding + this.theme.fg("borderAccent", "│");
  }

  private requestRender(): void {
    this.tui?.requestRender?.();
  }
}

class VimChatNavigationEditor extends CustomEditor {
  private mode: VimChatMode = "insert";

  constructor(
    private readonly tui: any,
    theme: any,
    keybindings: any,
    private readonly openChatNavigator: OpenChatNavigator,
    private readonly isIdle: IsIdleHandler,
    private readonly onModeChange?: ModeChangeHandler,
  ) {
    super(tui, theme, keybindings);
  }

  override handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (!this.isIdle()) {
        super.handleInput(data);
        return;
      }

      this.setMode("chat");
      this.openChatNavigator();
      return;
    }

    // Preserve Pi's default editor behavior in prompt mode, including Enter submit.
    super.handleInput(data);
  }

  setExternalMode(mode: VimChatMode): void {
    this.setMode(mode);
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

  private requestRender(): void {
    this.tui?.requestRender?.();
  }
}

export default function(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    let editor: VimChatNavigationEditor | undefined;
    let overlayOpen = false;

    const setModeStatus = (mode: VimChatMode) => {
      const label = mode === "insert"
        ? ctx.ui.theme.fg("accent", "mode: INSERT")
        : ctx.ui.theme.fg("warning", "mode: NAVIGATION");
      ctx.ui.setStatus("vim-chat-navigation", label);
    };

    const returnToInsert = () => {
      overlayOpen = false;
      editor?.setExternalMode("insert");
      setModeStatus("insert");
    };

    const openChatNavigator = () => {
      if (overlayOpen) return;
      overlayOpen = true;
      setModeStatus("chat");

      const items = getChatHistoryItems(ctx.sessionManager.getBranch());

      void ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => new ChatHistoryNavigator(
          items,
          tui,
          theme,
          () => done(),
          async (text) => {
            try {
              await copyText(text);
              ctx.ui.notify(`Yanked ${text.length} characters`, "info");
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(`Yank failed: ${message}`, "warning");
            }
          },
        ),
        {
          overlay: true,
          overlayOptions: {
            width: "90%",
            minWidth: 50,
            maxHeight: "80%",
            anchor: "center",
            margin: 1,
          },
        },
      ).then(returnToInsert, returnToInsert);
    };

    setModeStatus("insert");

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editor = new VimChatNavigationEditor(
        tui,
        theme,
        keybindings,
        openChatNavigator,
        () => ctx.isIdle(),
        setModeStatus,
      );
      return editor;
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("vim-chat-navigation", undefined);
    ctx.ui.setEditorComponent(undefined);
  });
}
