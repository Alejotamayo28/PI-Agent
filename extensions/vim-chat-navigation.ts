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
type MessageRole = "user" | "assistant" | "toolResult" | "bashExecution" | "custom" | "branchSummary" | "compactionSummary" | "entry";
type NavigatorMode = "normal" | "visualLine" | "visualChar";
type RenderedLineKind = "separator" | "title" | "accordion" | "body";
type SectionSeparatorLabel = "PROMPT" | "AGENT RESULT";

interface ChatHistoryItem {
  role: MessageRole;
  title: string;
  body: string;
  markdown?: boolean;
  accordionSummary?: string;
}

interface ExtractedContentBlock {
  text: string;
}

interface ContentExtractionOptions {
  includeText?: boolean;
  includeImages?: boolean;
  includeThinking?: boolean;
  includeToolCalls?: boolean;
}

interface RenderedLine {
  itemIndex: number;
  rawText: string;
  displayText?: string;
  kind: RenderedLineKind;
  separatorLabel?: SectionSeparatorLabel;
  accordionExpanded?: boolean;
}

interface TextRange {
  start: number;
  end: number;
}

type ModeChangeHandler = (mode: VimChatMode) => void;
type OpenChatNavigator = () => void;
type IsIdleHandler = () => boolean;
type YankHandler = (text: string) => void | Promise<void>;
type ComposeSelectionPromptHandler = (text: string) => void | Promise<void>;

const DEFAULT_VISIBLE_HISTORY_LINES = 20;
const MIN_VISIBLE_HISTORY_LINES = 10;
const OVERLAY_CHROME_LINES = 5; // top/header/position/middle/bottom
const OVERLAY_HEIGHT_RATIO = 0.95;

function getVisibleHistoryLineCount(): number {
  const rows = typeof process.stdout.rows === "number" ? process.stdout.rows : 0;
  if (rows <= 0) return DEFAULT_VISIBLE_HISTORY_LINES;

  const maxOverlayRows = Math.max(1, Math.floor(rows * OVERLAY_HEIGHT_RATIO));
  const availableHistoryRows = Math.max(1, maxOverlayRows - OVERLAY_CHROME_LINES);

  return rows >= OVERLAY_CHROME_LINES + MIN_VISIBLE_HISTORY_LINES
    ? Math.max(MIN_VISIBLE_HISTORY_LINES, availableHistoryRows)
    : availableHistoryRows;
}

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
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? cleanText(value).trim() : "";
}

function isPrimitivePlain(value: unknown): boolean {
  return value === undefined || value === null || ["string", "number", "boolean"].includes(typeof value);
}

function indentPlain(text: string, indent: number): string {
  const padding = " ".repeat(indent);
  return cleanText(text).split("\n").map((line) => `${padding}${line}`).join("\n");
}

function formatPlainValue(value: unknown, indent = 0): string {
  const padding = " ".repeat(indent);

  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return `${padding}[]`;
    return value.map((item) => {
      if (isPrimitivePlain(item)) return `${padding}- ${formatPlainValue(item, 0)}`;
      return `${padding}-\n${formatPlainValue(item, indent + 2)}`;
    }).join("\n");
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${padding}{}`;

    return entries.map(([key, nested]) => {
      if (isPrimitivePlain(nested)) {
        const text = formatPlainValue(nested, 0);
        if (!text.includes("\n")) return `${padding}${key}: ${text}`;
        return `${padding}${key}:\n${indentPlain(text, indent + 2)}`;
      }
      return `${padding}${key}:\n${formatPlainValue(nested, indent + 2)}`;
    }).join("\n");
  }

  return cleanText(String(value));
}


function imagePlaceholder(block: Record<string, unknown>): string {
  const mimeType = typeof block.mimeType === "string" && block.mimeType.trim()
    ? block.mimeType.trim()
    : "image";
  return `[image: ${mimeType}]`;
}

function formatToolCallArguments(args: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const cleaned = cleanText(value);
      lines.push(cleaned.includes("\n") ? `${key}:\n${cleaned}` : `${key}: ${cleaned}`);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      lines.push(`${key}: ${String(value)}`);
    } else {
      lines.push(`${key}:\n${formatPlainValue(value)}`);
    }
  }
  return lines.join("\n");
}

function formatToolCallBlock(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" && block.name.trim() ? block.name.trim() : "toolCall";
  const args = isRecord(block.arguments) ? block.arguments : undefined;
  if (!args) return `[tool call: ${name}]`;

  const command = stringArgument(args, "command");
  if (name === "bash" && command) return `[tool call: bash]\n${command}`;

  return `[tool call: ${name}]\n${formatToolCallArguments(args)}`.trimEnd();
}


function extractContentBlocks(content: unknown, options: ContentExtractionOptions = {}): ExtractedContentBlock[] {
  const includeText = options.includeText ?? true;
  const includeImages = options.includeImages ?? true;
  const includeThinking = options.includeThinking ?? false;
  const includeToolCalls = options.includeToolCalls ?? false;

  if (typeof content === "string") {
    const text = cleanText(content);
    return includeText && text ? [{ text }] : [];
  }

  if (!Array.isArray(content)) {
    const text = isRecord(content) ? formatPlainValue(content) : cleanText(content);
    return includeText && text ? [{ text }] : [];
  }

  const blocks: ExtractedContentBlock[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;

    switch (block.type) {
      case "text": {
        if (!includeText) break;
        const text = cleanText(block.text);
        if (text) blocks.push({ text });
        break;
      }
      case "image":
        if (includeImages) blocks.push({ text: imagePlaceholder(block) });
        break;
      case "thinking": {
        if (!includeThinking) break;
        const text = cleanText(block.thinking);
        if (text) blocks.push({ text: `[thinking]\n${text}` });
        break;
      }
      case "toolCall": {
        if (!includeToolCalls) break;
        const text = formatToolCallBlock(block);
        if (text) blocks.push({ text });
        break;
      }
      default:
        break;
    }
  }

  return blocks;
}

function contentBlocksToText(blocks: ExtractedContentBlock[]): string {
  return cleanText(blocks.map((block) => block.text).filter(Boolean).join("\n\n"));
}

function extractDisplayText(content: unknown, options?: ContentExtractionOptions): string {
  return contentBlocksToText(extractContentBlocks(content, options));
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

function compactLine(text: string, maxWidth = 120): string {
  const compact = cleanText(text).replace(/\s+/g, " ").trim();
  return compact ? truncateToWidth(compact, maxWidth, "…") : "";
}

function firstMeaningfulLine(text: string): string {
  return cleanText(text).split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function summarizeGenericToolArguments(args: Record<string, unknown>): string {
  for (const key of ["path", "file", "url", "query", "pattern", "command"]) {
    const value = stringArgument(args, key);
    if (value) return value;
  }

  for (const [key, value] of Object.entries(args)) {
    if (isPrimitivePlain(value)) {
      const text = compactLine(formatPlainValue(value), 80);
      if (text) return `${key}: ${text}`;
    }
  }

  return "";
}

function summarizeToolCallAction(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";

  if (name === "bash") return stringArgument(args, "command");
  if (["read", "write", "edit"].includes(name)) return stringArgument(args, "path");
  if (name === "grep") {
    const pattern = stringArgument(args, "pattern");
    const path = stringArgument(args, "path");
    return [pattern, path].filter(Boolean).join(" in ");
  }
  if (name === "find") {
    const pattern = stringArgument(args, "pattern");
    const path = stringArgument(args, "path");
    return [pattern, path].filter(Boolean).join(" under ");
  }
  if (name === "ls") return stringArgument(args, "path");

  return summarizeGenericToolArguments(args);
}

function extractToolCallSummaries(content: unknown): Map<string, string> {
  const summaries = new Map<string, string>();
  if (!Array.isArray(content)) return summaries;

  for (const block of content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    const id = typeof block.id === "string" && block.id.trim() ? block.id.trim() : "";
    const name = typeof block.name === "string" && block.name.trim() ? block.name.trim() : "tool";
    const args = isRecord(block.arguments) ? block.arguments : undefined;
    const action = compactLine(summarizeToolCallAction(name, args));
    if (id && action) summaries.set(id, action);
  }

  return summaries;
}

function formatUserMessage(message: Record<string, any>, entry: Record<string, any>): ChatHistoryItem {
  const body = extractDisplayText(message.content, { includeImages: true }) || "[empty user message]";
  return {
    role: "user",
    title: titleWithTime("USER", formatTimestamp(message, entry)),
    body: truncateBody(body),
    markdown: true,
  };
}

function formatAssistantMessage(message: Record<string, any>, entry: Record<string, any>): ChatHistoryItem {
  const body = extractDisplayText(message.content, {
    includeText: true,
    includeImages: true,
    includeThinking: true,
    includeToolCalls: true,
  });
  const assistantBody = body.trim() ? body : "[empty assistant message]";

  const model = message.model ? ` · ${message.model}` : "";
  return {
    role: "assistant",
    title: titleWithTime(`ASSISTANT${model}`, formatTimestamp(message, entry)),
    body: truncateBody(assistantBody),
    markdown: true,
  };
}

function formatToolResultMessage(
  message: Record<string, any>,
  entry: Record<string, any>,
  toolCallSummary?: string,
): ChatHistoryItem {
  const toolName = typeof message.toolName === "string" && message.toolName.trim()
    ? message.toolName.trim()
    : "tool";
  const status = message.isError ? "ERROR" : "OK";
  const body = extractDisplayText(message.content, { includeImages: true }) || "[empty tool result]";
  const accordionSummary = compactLine(toolCallSummary || firstMeaningfulLine(body) || "result");

  return {
    role: "toolResult",
    title: titleWithTime(`TOOL ${toolName} · ${status}`, formatTimestamp(message, entry)),
    body: truncateBody(body),
    markdown: false,
    accordionSummary,
  };
}

function bashStatus(message: Record<string, any>): string {
  if (message.cancelled) return "cancelled";
  const exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
  if (exitCode === undefined) return "no exit";
  return `exit ${exitCode}`;
}

function formatBashExecutionMessage(message: Record<string, any>, entry: Record<string, any>): ChatHistoryItem {
  const command = cleanText(message.command).trim();
  const output = cleanText(message.output);
  const statusParts = [bashStatus(message)];
  if (message.truncated) statusParts.push("truncated");
  if (message.excludeFromContext) statusParts.push("local");

  const bodyParts = [command ? `$ ${command}` : "$ [empty command]"];
  bodyParts.push(output || "[no output]");
  if (message.truncated && message.fullOutputPath) {
    bodyParts.push(`[full output: ${cleanText(message.fullOutputPath)}]`);
  } else if (message.truncated) {
    bodyParts.push("[output truncated]");
  }

  return {
    role: "bashExecution",
    title: titleWithTime(`BASH · ${statusParts.join(" · ")}`, formatTimestamp(message, entry)),
    body: truncateBody(bodyParts.filter(Boolean).join("\n\n")),
    markdown: false,
    accordionSummary: compactLine(command || "[empty command]"),
  };
}

function formatCustomMessage(message: Record<string, any>, entry: Record<string, any>): ChatHistoryItem {
  const customType = typeof message.customType === "string" && message.customType.trim()
    ? message.customType.trim()
    : "custom";
  const visibility = message.display === false ? " · hidden" : "";
  const body = extractDisplayText(message.content, { includeImages: true }) || "[empty custom message]";

  return {
    role: "custom",
    title: titleWithTime(`CUSTOM · ${customType}${visibility}`, formatTimestamp(message, entry)),
    body: truncateBody(body),
    markdown: true,
  };
}

function formatBranchSummaryMessage(message: Record<string, any>, entry: Record<string, any>): ChatHistoryItem {
  return {
    role: "branchSummary",
    title: titleWithTime("BRANCH SUMMARY", formatTimestamp(message, entry)),
    body: truncateBody(cleanText(message.summary) || "[empty branch summary]"),
    markdown: true,
  };
}

function formatCompactionSummaryMessage(message: Record<string, any>, entry: Record<string, any>): ChatHistoryItem {
  return {
    role: "compactionSummary",
    title: titleWithTime("COMPACTION SUMMARY", formatTimestamp(message, entry)),
    body: truncateBody(cleanText(message.summary) || "[empty compaction summary]"),
    markdown: true,
  };
}

function formatUnknownMessage(message: Record<string, any>, entry: Record<string, any>): ChatHistoryItem {
  const role = typeof message.role === "string" && message.role.trim() ? message.role.trim() : "unknown";
  const body = extractDisplayText(message.content, {
    includeText: true,
    includeImages: true,
    includeThinking: true,
    includeToolCalls: true,
  }) || cleanText(message.summary) || cleanText(message.output) || "[empty message]";
  return {
    role: "entry",
    title: titleWithTime(`MESSAGE · ${role}`, formatTimestamp(message, entry)),
    body: truncateBody(body),
    markdown: true,
  };
}

function formatMessageEntry(
  entry: Record<string, any>,
  toolCallSummaries: Map<string, string> = new Map(),
): ChatHistoryItem | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
    return undefined;
  }

  const message = entry.message as Record<string, any>;
  let item: ChatHistoryItem;
  switch (message.role) {
    case "user":
      item = formatUserMessage(message, entry);
      break;
    case "assistant":
      item = formatAssistantMessage(message, entry);
      break;
    case "toolResult": {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      item = formatToolResultMessage(message, entry, toolCallSummaries.get(toolCallId));
      break;
    }
    case "bashExecution":
      item = formatBashExecutionMessage(message, entry);
      break;
    case "custom":
      item = formatCustomMessage(message, entry);
      break;
    case "branchSummary":
      item = formatBranchSummaryMessage(message, entry);
      break;
    case "compactionSummary":
      item = formatCompactionSummaryMessage(message, entry);
      break;
    default:
      item = formatUnknownMessage(message, entry);
      break;
  }

  return item;
}

function getChatHistoryItems(branchEntries: readonly unknown[]): ChatHistoryItem[] {
  const toolCallSummaries = new Map<string, string>();
  const items: ChatHistoryItem[] = [];

  for (const rawEntry of branchEntries) {
    const entry = (rawEntry ?? {}) as Record<string, any>;
    const item = formatMessageEntry(entry, toolCallSummaries);
    if (item) items.push(item);

    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const message = entry.message as Record<string, any>;
      extractToolCallSummaries(message.content).forEach((summary, id) => {
        toolCallSummaries.set(id, summary);
      });
    }
  }

  return items;
}

function getSectionSeparatorLabel(
  item: ChatHistoryItem,
  previousItem: ChatHistoryItem | undefined,
): SectionSeparatorLabel | undefined {
  if (item.role === "user") return "PROMPT";
  if (!previousItem || previousItem.role === "user") return "AGENT RESULT";
  return undefined;
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

function themeFg(theme: any, color: string, text: string): string {
  try {
    return typeof theme?.fg === "function" ? theme.fg(color, text) : text;
  } catch {
    return text;
  }
}

function styleInlineMarkdown(text: string, theme: any): string {
  const segments = text.split(/(`[^`]*`)/g);
  return segments.map((segment) => {
    if (segment.startsWith("`") && segment.endsWith("`") && segment.length >= 2) {
      return themeFg(theme, "mdCode", segment);
    }

    return segment
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
        return `${themeFg(theme, "mdLink", String(label))}${themeFg(theme, "dim", ` (${String(url)})`)}`;
      })
      .replace(/\*\*([^*]+)\*\*/g, (_match, value) => themeFg(theme, "accent", String(value)));
  }).join("");
}

function styleMarkdownLine(text: string, theme: any, state: { inCodeFence: boolean }): string {
  const trimmed = text.trimStart();
  const leading = text.slice(0, text.length - trimmed.length);

  if (/^```/.test(trimmed)) {
    const styled = themeFg(theme, "mdCodeBlockBorder", text);
    state.inCodeFence = !state.inCodeFence;
    return styled;
  }

  if (state.inCodeFence) return themeFg(theme, "mdCodeBlock", text);
  if (!trimmed.trim()) return text;

  if (/^#{1,6}\s+/.test(trimmed)) return leading + themeFg(theme, "mdHeading", trimmed);
  if (/^>\s?/.test(trimmed)) {
    return leading + themeFg(theme, "mdQuoteBorder", ">") + themeFg(theme, "mdQuote", trimmed.replace(/^>\s?/, " "));
  }
  if (/^([-*_])\s*\1\s*\1(?:\s*\1)*\s*$/.test(trimmed)) return leading + themeFg(theme, "mdHr", trimmed);
  if (/^([-*+] |\d+\.\s+)/.test(trimmed)) {
    const marker = trimmed.match(/^([-*+] |\d+\.\s+)/)?.[0] ?? "";
    return leading + themeFg(theme, "mdListBullet", marker) + styleInlineMarkdown(trimmed.slice(marker.length), theme);
  }

  return leading + styleInlineMarkdown(trimmed, theme);
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

function formatAskSelectionPrompt(text: string): string {
  const selectedText = cleanText(text).replace(/^\n+/, "").replace(/\n+$/, "");
  return `\`\`\`text\n${selectedText}\n\`\`\``;
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
  private readonly expandedAccordionItems = new Set<number>();

  constructor(
    private readonly items: ChatHistoryItem[],
    private readonly tui: any,
    private readonly theme: any,
    private readonly onClose: () => void,
    private readonly onYank: YankHandler,
    private readonly onComposeSelectionPrompt: ComposeSelectionPromptHandler,
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
      if (this.mode === "normal" && this.toggleSelectedAccordionItem()) return;
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
    const visibleCount = getVisibleHistoryLineCount();
    this.clampSelection(historyLines.length);
    this.ensureVisualStateInBounds(historyLines.length);
    this.ensureSelectionVisible(visibleCount, historyLines.length);

    const selectedItem = historyLines[this.selectedLine]?.itemIndex ?? 0;
    const header = this.theme.fg("accent", ` ${this.modeLabel()} `) + this.theme.fg(
      "muted",
      `current session transcript • j/k move • h/l message • Enter toggle tool • V/v select • y yank • ? ask • Esc cancel/close`,
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
      lines.push(this.padLine(this.theme.fg("muted", "No session transcript yet."), safeWidth));
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
          const shouldHighlight = (this.mode === "normal" && globalIndex === this.selectedLine)
            || (this.mode === "visualLine" && this.isLineInVisualLineRange(globalIndex));
          const separator = this.theme.fg("borderMuted", this.formatSeparator(line.separatorLabel, safeWidth));
          lines.push(
            this.padLine(shouldHighlight ? this.theme.bg("selectedBg", separator) : separator, safeWidth),
          );
          continue;
        }

        const marker = globalIndex === this.selectedLine ? "▶ " : "  ";
        const renderedText = this.renderHistoryLine(globalIndex, line);
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
    if (data === "?") {
      void this.askSelection();
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

  private async askSelection(): Promise<void> {
    const text = this.getSelectedText();
    if (!text.trim()) {
      this.cancelVisualMode();
      return;
    }

    try {
      await this.onComposeSelectionPrompt(text);
      this.mode = "normal";
    } catch {
      // The callback owns user-facing failure notifications.
    } finally {
      this.requestRender();
    }
  }

  private getSelectedText(): string {
    const lines = this.getRenderedLines(this.cachedWidth ?? 80);
    if (this.mode === "visualLine") {
      const [start, end] = this.getOrderedLineRange();
      return lines.slice(start, end + 1).map((line) => line.rawText).join("\n");
    }

    if (this.mode !== "visualChar") return "";

    const [startLine, endLine] = this.getOrderedLineRange();
    const selected: string[] = [];
    for (let lineIndex = startLine; lineIndex <= endLine; lineIndex++) {
      const text = lines[lineIndex]?.rawText ?? "";
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
    const appendBodyLines = (item: ChatHistoryItem, itemIndex: number) => {
      const bodyWidth = Math.max(1, width - 2);
      const markdownState = { inCodeFence: false };
      for (const sourceLine of cleanText(item.body).split("\n")) {
        for (const bodyLine of wrapPlainLine(sourceLine || " ", bodyWidth)) {
          const rawText = `  ${bodyLine}`;
          const displayBody = item.markdown === false
            ? bodyLine
            : styleMarkdownLine(bodyLine, this.theme, markdownState);
          lines.push({ itemIndex, rawText, displayText: `  ${displayBody}`, kind: "body" });
        }
      }
    };

    this.items.forEach((item, itemIndex) => {
      const separatorLabel = getSectionSeparatorLabel(item, this.items[itemIndex - 1]);
      if (separatorLabel) {
        lines.push({ itemIndex, rawText: "", kind: "separator", separatorLabel });
      }

      if (this.isAccordionItem(itemIndex)) {
        const accordionExpanded = this.expandedAccordionItems.has(itemIndex);
        lines.push({
          itemIndex,
          rawText: this.formatAccordionLine(item, accordionExpanded),
          displayText: this.formatAccordionLine(item, accordionExpanded, true),
          kind: "accordion",
          accordionExpanded,
        });
        if (accordionExpanded) appendBodyLines(item, itemIndex);
        return;
      }

      lines.push({
        itemIndex,
        rawText: this.formatTitle(item),
        displayText: this.formatTitle(item, true),
        kind: "title",
      });
      appendBodyLines(item, itemIndex);
    });

    this.cachedWidth = width;
    this.cachedLines = lines.length > 0
      ? lines
      : [{ itemIndex: 0, rawText: "No session transcript yet.", displayText: this.theme.fg("muted", "No session transcript yet."), kind: "body" }];
    return this.cachedLines;
  }

  private formatTitle(item: ChatHistoryItem, styled = false): string {
    const icon = {
      user: "",
      assistant: "π",
      toolResult: "🔧",
      bashExecution: "$",
      custom: "◇",
      branchSummary: "⑂",
      compactionSummary: "⬡",
      entry: "·",
    }[item.role];
    const raw = `${icon} ${item.title}`;
    if (!styled) return raw;

    const color = {
      user: "userMessageText",
      assistant: "accent",
      toolResult: item.title.includes("ERROR") ? "error" : "success",
      bashExecution: item.title.includes("exit 0") ? "success" : item.title.includes("cancelled") ? "warning" : "error",
      custom: "customMessageLabel",
      branchSummary: "muted",
      compactionSummary: "muted",
      entry: "dim",
    }[item.role];
    return themeFg(this.theme, color, raw);
  }

  private formatAccordionLine(item: ChatHistoryItem, expanded: boolean, styled = false): string {
    const arrow = expanded ? "▼" : "▶";
    const title = this.formatTitle(item, styled);
    const summary = item.accordionSummary ? ` · ${item.accordionSummary}` : "";
    const renderedSummary = styled ? themeFg(this.theme, "dim", summary) : summary;
    return `${arrow} ${title}${renderedSummary}`;
  }

  private isAccordionItem(itemIndex: number): boolean {
    return typeof this.items[itemIndex]?.accordionSummary === "string";
  }

  private shouldSkipGroupNavigationItem(itemIndex: number): boolean {
    const role = this.items[itemIndex]?.role;
    return role === "toolResult" || role === "bashExecution";
  }

  private findGroupNavigationTargetItem(currentItem: number, delta: number): number | undefined {
    if (this.items.length === 0 || delta === 0) return undefined;

    for (let itemIndex = currentItem + delta; itemIndex >= 0 && itemIndex < this.items.length; itemIndex += delta) {
      if (!this.shouldSkipGroupNavigationItem(itemIndex)) return itemIndex;
    }

    return undefined;
  }

  private toggleSelectedAccordionItem(): boolean {
    const lines = this.getRenderedLines(this.cachedWidth ?? 80);
    const itemIndex = lines[this.selectedLine]?.itemIndex;
    if (itemIndex === undefined || !this.isAccordionItem(itemIndex)) return false;

    if (this.expandedAccordionItems.has(itemIndex)) {
      this.expandedAccordionItems.delete(itemIndex);
    } else {
      this.expandedAccordionItems.add(itemIndex);
    }

    const width = this.cachedWidth ?? 80;
    this.invalidate();
    const nextLines = this.getRenderedLines(width);
    const targetLine = this.findItemTitleLine(nextLines, itemIndex);
    if (targetLine >= 0) {
      this.selectedLine = targetLine;
      this.cursorLine = targetLine;
    } else {
      this.clampSelection(nextLines.length);
      this.cursorLine = this.selectedLine;
    }
    this.requestRender();
    return true;
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
    const targetItem = this.findGroupNavigationTargetItem(currentItem, delta);
    if (targetItem !== undefined) {
      const targetLine = this.findItemTitleLine(lines, targetItem);
      if (targetLine >= 0) {
        this.selectedLine = targetLine;
        this.cursorLine = this.selectedLine;
      }
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
    const targetItem = this.findGroupNavigationTargetItem(currentItem, delta);
    if (targetItem !== undefined) {
      const targetLine = this.findItemTitleLine(lines, targetItem);
      if (targetLine >= 0) {
        this.selectedLine = targetLine;
        this.cursorLine = this.selectedLine;
      }
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

  private renderHistoryLine(lineIndex: number, line: RenderedLine): string {
    const rawText = line.rawText;
    const displayText = line.displayText ?? rawText;

    if (this.mode === "visualLine" && this.isLineInVisualLineRange(lineIndex)) {
      return this.theme.bg("selectedBg", displayText || " ");
    }

    if (this.mode === "visualChar") {
      const range = this.getVisualCharRangeForLine(lineIndex, rawText);
      if (range) {
        // Highlight the whole line — working on displayText preserves
        // markdown/ANSI styling that rawText discards.  Character-level
        // selection precision is still used for yanking (getSelectedText).
        return this.theme.bg("selectedBg", displayText || " ");
      }
    }

    return displayText;
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
    const titleLine = lines.findIndex(
      (line) => line.itemIndex === itemIndex && (line.kind === "title" || line.kind === "accordion"),
    );
    if (titleLine >= 0) return titleLine;

    // Fallback: first non-separator line of the target item — never land on an
    // invisible separator where the ▶ cursor / selection highlight is hidden.
    const firstBody = lines.findIndex(
      (line) => line.itemIndex === itemIndex && line.kind !== "separator",
    );
    return firstBody >= 0 ? firstBody : -1;
  }

  private maxColumnForLine(lineIndex: number): number {
    const lines = this.getRenderedLines(this.cachedWidth ?? 80);
    const text = lines[lineIndex]?.rawText ?? "";
    return Math.max(0, textChars(text).length - 1);
  }

  private clampColumn(lineIndex: number, column: number): number {
    return clamp(column, 0, this.maxColumnForLine(lineIndex));
  }

  private formatSeparator(label: SectionSeparatorLabel | undefined, width: number): string {
    const innerWidth = Math.max(0, width - 2);
    if (!label) return "─".repeat(innerWidth);

    const labelText = ` ${label} `;
    const labelWidth = visibleWidth(labelText);
    if (labelWidth >= innerWidth) return truncateToWidth(label.trim(), innerWidth, "");

    const remaining = innerWidth - labelWidth;
    const leftWidth = Math.floor(remaining / 2);
    const rightWidth = remaining - leftWidth;
    return `${"─".repeat(leftWidth)}${labelText}${"─".repeat(rightWidth)}`;
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
          async (text) => {
            try {
              ctx.ui.setEditorText(formatAskSelectionPrompt(text));
              ctx.ui.notify("Drafted ask prompt from selection", "info");
              done();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(`Draft failed: ${message}`, "warning");
              throw error;
            }
          },
        ),
        {
          overlay: true,
          overlayOptions: {
            width: "90%",
            minWidth: 50,
            maxHeight: "95%",
            anchor: "center",
            margin: 0,
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
