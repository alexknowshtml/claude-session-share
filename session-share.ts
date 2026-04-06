#!/usr/bin/env bun
/**
 * session-share.ts — Claude Code session transcript → pretty HTML → S3-compatible upload
 *
 * Usage:
 *   bun session-share.ts                              # interactive picker
 *   bun session-share.ts path/to/file.jsonl           # render specific session
 *   bun session-share.ts path/to/file.jsonl --output out.html  # write to file (no upload)
 *
 * Upload env vars (required unless --output is used):
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL, AWS_REGION, S3_BUCKET
 *   Optional: S3_PREFIX (default: "public/"), S3_PUBLIC_URL (override URL base)
 */

import { marked } from "marked";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

// ─── Types ─────────────────────────────────────────────────────────────────

interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image";
  id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
  is_error?: boolean;
  tool_use_id?: string;
  source?: { media_type: string; data: string };
}

interface Entry {
  type: string;
  timestamp?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    content: string | ContentBlock[];
  };
}

// ─── JSONL Parser ──────────────────────────────────────────────────────────

function parseTranscript(filePath: string): Entry[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((e) => e.type === "user" || e.type === "assistant");
}

// Extract the human-visible part of a user message.
// Discord sessions wrap the real message in "**Message:**" field of a system prompt.
function extractUserText(content: string | ContentBlock[]): string {
  const raw = typeof content === "string" ? content
    : Array.isArray(content)
      ? content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n")
      : "";

  // Discord agent context injection — extract just the **Message:** section
  if (raw.includes("[ANDY-INTERNAL-TASK]")) {
    const msgMatch = raw.match(/\*\*Message:\*\*\s*([\s\S]*?)(?:\n##|\n\*\*|$)/);
    if (msgMatch) {
      const msg = msgMatch[1].trim();
      // Filter session-resume auto-inject from the bridge
      if (msg.startsWith("Continue from where you left off")) return "";
      return msg;
    }
    return ""; // Skip pure system injections with no readable message
  }

  const trimmed = raw.trim();
  // Filter bare session-resume auto-inject
  if (trimmed.startsWith("Continue from where you left off")) return "";
  // Filter Claude Code context-compaction summary injection
  if (trimmed.startsWith("This session is being continued from a previous conversation")) return "";
  // Filter skill expansions (always start with "Base directory for this skill:")
  if (trimmed.startsWith("Base directory for this skill:")) return "";
  // Filter skill content injected without base-dir prefix (starts with "# /commandname")
  if (/^# \/\w/.test(trimmed)) return "";
  // Filter background task notifications
  if (trimmed.startsWith("<task-notification>")) return "";
  return trimmed;
}

function getTitle(entries: Entry[], filePath: string): string {
  for (const e of entries) {
    if (e.type === "user" && !e.isMeta) {
      const text = extractUserText(e.message?.content ?? "");
      if (text.length > 4) return text.slice(0, 80);
    }
  }
  return path.basename(filePath, ".jsonl");
}

// ─── Indexes ───────────────────────────────────────────────────────────────
// Map tool_use_id → tool_result block so results inline under their tool_use

function buildResultIndex(entries: Entry[]): Map<string, ContentBlock> {
  const map = new Map<string, ContentBlock>();
  for (const entry of entries) {
    if (entry.type !== "user" || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content as ContentBlock[]) {
      if (block.type === "tool_result" && block.tool_use_id) {
        map.set(block.tool_use_id, block);
      }
    }
  }
  return map;
}

// ─── HTML Escape & Markdown ────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMd(text: string): string {
  return marked.parse(text, { async: false, breaks: true }) as string;
}

// ─── Block Renderers ────────────────────────────────────────────────────────

function renderInlineResult(block: ContentBlock, toolName: string): string {
  const isErr = block.is_error;
  // Read/Glob/Grep: skip unless error
  if (["Read", "Glob", "Grep"].includes(toolName) && !isErr) return "";

  const raw = typeof block.content === "string"
    ? block.content
    : Array.isArray(block.content)
      ? block.content.filter((b) => b.type === "text").map((b) => b.text || "").join("")
      : "";
  const preview = raw.length > 1500 ? raw.slice(0, 1500) + "\n… (truncated)" : raw;
  return `<details class="tool-result ${isErr ? "tool-result-error" : "tool-result-ok"}">
    <summary class="tool-result-label">${isErr ? "⚠ Error" : "Result"}</summary>
    <pre><code>${esc(preview)}</code></pre>
  </details>`;
}

function renderToolUse(block: ContentBlock, resultIndex?: Map<string, ContentBlock>): string {
  const name = block.name || "tool";
  const input = block.input || {};
  const resultBlock = block.id ? resultIndex?.get(block.id) : undefined;
  const inlineResult = resultBlock ? renderInlineResult(resultBlock, name) : "";

  if (name === "Bash") {
    const cmd = (input.command as string) || "";
    const desc = (input.description as string) || "";
    // suggest-options.sh — parse and show the actual button labels
    if (cmd.includes("suggest-options.sh")) {
      const jsonMatch = cmd.match(/echo\s+'(\{[\s\S]*?\})'\s*\|/);
      let labels: string[] = [];
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          labels = (parsed.options || []).map((o: { label: string }) => o.label);
        } catch {}
      }
      const pills = labels.map((l) => `<span class="suggest-pill">${esc(l)}</span>`).join("");
      return `<div class="tool-block tool-suggest">
        <div class="tool-header">
          <span class="tool-badge tool-badge-suggest">Offered choices</span>
          ${pills ? `<span class="suggest-pills">${pills}</span>` : ""}
        </div>
      </div>`;
    }
    return `<div class="tool-block tool-bash">
      <div class="tool-header">
        <span class="tool-badge tool-badge-bash">Bash</span>
        ${desc ? `<span class="tool-desc">${esc(desc)}</span>` : ""}
      </div>
      <pre><code>${esc(cmd)}</code></pre>
      ${inlineResult}
    </div>`;
  }

  if (name === "Write") {
    const fp = (input.file_path as string) || "";
    const content = (input.content as string) || "";
    const preview = content.length > 600 ? content.slice(0, 600) + "\n… (truncated)" : content;
    return `<div class="tool-block tool-write">
      <div class="tool-header">
        <span class="tool-badge tool-badge-write">Write</span>
        <span class="tool-path">${esc(fp)}</span>
      </div>
      <pre><code>${esc(preview)}</code></pre>
      ${inlineResult}
    </div>`;
  }

  if (name === "Edit") {
    const fp = (input.file_path as string) || "";
    const oldStr = (input.old_string as string) || "";
    const newStr = (input.new_string as string) || "";
    return `<div class="tool-block tool-edit">
      <div class="tool-header">
        <span class="tool-badge tool-badge-edit">Edit</span>
        <span class="tool-path">${esc(fp)}</span>
      </div>
      <div class="diff-view">
        <pre class="diff-old"><code>${esc(oldStr.slice(0, 400))}</code></pre>
        <pre class="diff-new"><code>${esc(newStr.slice(0, 400))}</code></pre>
      </div>
      ${inlineResult}
    </div>`;
  }

  if (name === "TodoWrite") {
    const raw = input.todos;
    const todos: Array<{ content: string; status: string }> = typeof raw === "string"
      ? (() => { try { return JSON.parse(raw); } catch { return []; } })()
      : Array.isArray(raw) ? raw : [];
    const items = todos.map((t) => {
      const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○";
      const cls = t.status === "completed" ? "todo-done" : t.status === "in_progress" ? "todo-active" : "";
      return `<li class="todo-item ${cls}"><span class="todo-icon">${icon}</span><span>${esc(t.content)}</span></li>`;
    }).join("");
    return `<div class="tool-block tool-todo">
      <div class="tool-header"><span class="tool-badge tool-badge-todo">Tasks</span></div>
      <ul class="todo-list">${items}</ul>
    </div>`;
  }

  if (["Read", "Glob", "Grep"].includes(name)) {
    const main = String(input.file_path || input.pattern || input.query || "");
    return `<div class="tool-block tool-generic">
      <div class="tool-header">
        <span class="tool-badge tool-badge-generic">${esc(name)}</span>
        <span class="tool-path">${esc(main)}</span>
      </div>
      ${inlineResult}
    </div>`;
  }

  // Generic fallback
  const inputStr = JSON.stringify(input, null, 2);
  const preview = inputStr.length > 400 ? inputStr.slice(0, 400) + "\n…" : inputStr;
  return `<div class="tool-block tool-generic">
    <div class="tool-header"><span class="tool-badge tool-badge-generic">${esc(name)}</span></div>
    <pre><code>${esc(preview)}</code></pre>
    ${inlineResult}
  </div>`;
}

function renderBlock(block: ContentBlock, resultIndex?: Map<string, ContentBlock>): string {
  switch (block.type) {
    case "text":
      return `<div class="text-block">${renderMd(block.text || "")}</div>`;

    case "thinking":
      return `<details class="thinking-block">
        <summary>Thinking</summary>
        <div class="thinking-content"><pre><code>${esc(block.thinking || "")}</code></pre></div>
      </details>`;

    case "tool_use":
      return renderToolUse(block, resultIndex);

    case "tool_result":
      // Results are inlined inside their tool_use block — skip standalone rendering
      return "";

    case "image":
      return block.source?.data
        ? `<img class="inline-image" src="data:${block.source.media_type};base64,${block.source.data}" alt="Inline image">`
        : "";

    default:
      return "";
  }
}

// Extract suggest-option labels from a single entry (if it runs suggest-options.sh)
function extractSuggestLabelsFromEntry(entry: Entry): string[] {
  if (!Array.isArray(entry.message?.content)) return [];
  for (const b of entry.message.content as ContentBlock[]) {
    if (b.type === "tool_use" && b.name === "Bash") {
      const cmd = (b.input?.command as string) || "";
      if (cmd.includes("suggest-options.sh")) {
        const jsonMatch = cmd.match(/echo\s+'(\{[\s\S]*?\})'\s*\|/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            return (parsed.options || []).map((o: { label: string }) => o.label);
          } catch {}
        }
      }
    }
  }
  return [];
}

// Render a user message as a highlighted button selection
function renderButtonSelection(entry: Entry, selectedLabel: string): string {
  const time = entry.timestamp
    ? new Date(entry.timestamp).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  return `<div class="message message-user">
    <div class="msg-header">
      <span class="msg-label">You</span>
      ${time ? `<span class="msg-time">${time}</span>` : ""}
    </div>
    <div class="msg-body">
      <span class="selected-button-pill">✓ ${esc(selectedLabel)}</span>
    </div>
  </div>`;
}

function renderEntry(entry: Entry, resultIndex: Map<string, ContentBlock>): string {
  if (!entry.message) return "";
  const isUser = entry.type === "user";
  const content = entry.message.content;

  // User turns that are purely tool_results are inlined into Claude blocks — skip
  if (isUser && Array.isArray(content) && (content as ContentBlock[]).every((b) => b.type === "tool_result")) {
    return "";
  }

  const time = entry.timestamp
    ? new Date(entry.timestamp).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

  // Tool-only assistant turns are handled by renderEntries grouping — skip here
  if (!isUser && Array.isArray(content)) {
    const blocks = content as ContentBlock[];
    const hasText = blocks.some((b) => b.type === "text" && (b.text || "").trim());
    if (!hasText) return ""; // handled by group renderer
    // Filter "No response requested." — Claude's reply to session-resume injects
    const allText = blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("").trim();
    if (allText === "No response requested.") return "";
  }

  let body = "";
  if (typeof content === "string") {
    const text = extractUserText(content);
    if (!text) return ""; // Skip pure system injections
    body = `<div class="text-block">${renderMd(text)}</div>`;
  } else if (Array.isArray(content)) {
    // For user turns, run the same system-injection filter on array text content
    if (isUser && !extractUserText(content)) return "";
    body = (content as ContentBlock[]).map((b) => renderBlock(b, resultIndex)).join("");
    if (!body.trim()) return "";
  }

  return `<div class="message message-${isUser ? "user" : "assistant"}">
    <div class="msg-header">
      <span class="msg-label">${isUser ? "You" : "Claude"}</span>
      ${time ? `<span class="msg-time">${time}</span>` : ""}
    </div>
    <div class="msg-body">${body}</div>
  </div>`;
}

// ─── CSS ───────────────────────────────────────────────────────────────────

const CSS = `
  :root {
    --font-display: 'Fraunces', serif;
    --font-body: 'DM Sans', sans-serif;
    --font-mono: 'DM Mono', monospace;
    --paper: #F7F3ED;
    --ink: #1C1C1C;
    --red: #E63946;
    --blue: #457B9D;
    --yellow: #F4A261;
    --green: #2A9D8F;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; min-width: 0; }
  html, body { overflow-x: hidden; max-width: 100vw; }
  body {
    font-family: var(--font-body);
    background: var(--paper);
    color: var(--ink);
    font-size: 15px;
    line-height: 1.7;
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 1000;
  }
  .page { max-width: 760px; margin: 0 auto; padding: 3rem 2rem 5rem; }
  h1.page-title {
    font-family: var(--font-display);
    font-weight: 900;
    font-size: clamp(1.75rem, 4vw, 2.5rem);
    line-height: 1.15;
    margin-bottom: 0.5rem;
    color: var(--ink);
  }
  .session-meta {
    font-size: 0.82em;
    color: rgba(28,28,28,0.5);
    margin-bottom: 2.5rem;
  }
  /* Messages */
  .message { margin-bottom: 1.5rem; overflow-x: hidden; }
  .msg-body { overflow-x: hidden; }
  .msg-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.4rem;
  }
  .msg-label {
    font-family: var(--font-body);
    font-size: 0.72em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0.15em 0.55em;
    border-radius: 3px;
  }
  .message-user .msg-label {
    background: var(--ink);
    color: var(--paper);
  }
  .message-assistant .msg-label {
    background: var(--blue);
    color: var(--paper);
  }
  .msg-time {
    font-size: 0.78em;
    color: rgba(28,28,28,0.35);
  }
  .msg-body { padding-left: 0.25rem; }
  .message-user { border-left: 3px solid var(--ink); padding-left: 1rem; }
  .message-assistant { border-left: 3px solid var(--blue); padding-left: 1rem; }
  /* Text blocks */
  .text-block { overflow-wrap: break-word; word-break: break-word; }
  .text-block p { margin-bottom: 0.85rem; }
  .text-block p:last-child { margin-bottom: 0; }
  .text-block h1,.text-block h2,.text-block h3 {
    font-family: var(--font-display);
    font-weight: 700;
    margin: 1.25rem 0 0.5rem;
  }
  .text-block h1 { font-size: 1.5rem; border-bottom: 2px solid var(--ink); padding-bottom: 0.25rem; }
  .text-block h2 { font-size: 1.25rem; }
  .text-block h3 { font-size: 1.05rem; color: var(--blue); }
  .text-block ul, .text-block ol { padding-left: 1.5rem; margin-bottom: 0.85rem; }
  .text-block li { margin-bottom: 0.25rem; }
  .text-block li::marker { color: var(--red); }
  .text-block code {
    font-family: var(--font-mono);
    background: rgba(28,28,28,0.07);
    padding: 0.15rem 0.35rem;
    font-size: 0.84em;
    border: 1px solid rgba(28,28,28,0.1);
    border-radius: 3px;
  }
  .text-block pre {
    background: var(--ink);
    color: var(--paper);
    padding: 1.1rem 1.25rem;
    margin: 1rem 0;
    overflow-x: auto;
    max-width: 100%;
    font-size: 0.83em;
    line-height: 1.5;
    box-shadow: 4px 4px 0 var(--blue);
  }
  .text-block pre code { background: none; border: none; padding: 0; color: inherit; }
  .text-block blockquote {
    border-left: 4px solid var(--red);
    margin: 1rem 0;
    padding: 0.6rem 1rem;
    background: rgba(69,123,157,0.06);
    box-shadow: 3px 3px 0 var(--ink);
  }
  .text-block a { color: var(--blue); text-decoration: underline; text-decoration-thickness: 1px; }
  .text-block a:hover { color: var(--red); }
  .text-block strong { font-weight: 600; }
  /* Thinking */
  .thinking-block {
    margin: 0.75rem 0;
    border: 1px solid rgba(244,162,97,0.35);
    border-left: 3px solid var(--yellow);
    border-radius: 3px;
    background: rgba(244,162,97,0.06);
  }
  .thinking-block summary {
    cursor: pointer;
    padding: 0.4rem 0.75rem;
    font-family: var(--font-body);
    font-size: 0.78em;
    font-weight: 500;
    color: rgba(28,28,28,0.55);
    list-style: none;
    user-select: none;
  }
  .thinking-block summary::-webkit-details-marker { display: none; }
  .thinking-block summary::before { content: '▶ '; font-size: 0.65em; }
  .thinking-block[open] summary::before { content: '▼ '; }
  .thinking-content { padding: 0.5rem 0.75rem 0.75rem; font-size: 0.88em; line-height: 1.6; color: rgba(28,28,28,0.75); }
  .thinking-content pre { font-family: var(--font-mono); font-size: 0.9em; line-height: 1.5; background: none; box-shadow: none; padding: 0; white-space: pre-wrap; word-break: break-word; }
  .thinking-content code { font-family: var(--font-mono); background: none; border: none; padding: 0; }
  /* Tool blocks */
  .tool-block {
    margin: 0.6rem 0;
    border-radius: 3px;
    overflow: hidden;
  }
  .tool-header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0.75rem;
    font-family: var(--font-body);
    font-size: 0.82em;
  }
  .tool-badge {
    font-weight: 500;
    padding: 0.1em 0.5em;
    border-radius: 3px;
    color: var(--paper);
    font-size: 0.9em;
    white-space: nowrap;
  }
  .tool-block pre {
    margin: 0;
    padding: 0.75rem 1rem;
    font-size: 0.8em;
    line-height: 1.45;
    overflow-x: auto;
  }
  .tool-block code { font-family: var(--font-mono); }
  /* Bash */
  .tool-bash { border: 1px solid rgba(28,28,28,0.15); background: rgba(28,28,28,0.02); }
  .tool-bash .tool-header { background: var(--ink); color: var(--paper); }
  .tool-badge-bash { background: rgba(255,255,255,0.15); }
  .tool-bash .tool-desc { color: rgba(255,255,255,0.6); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .tool-bash pre { background: rgba(28,28,28,0.04); color: var(--ink); }
  /* Write */
  .tool-write { border: 1px solid rgba(42,157,143,0.3); }
  .tool-write .tool-header { background: var(--green); color: var(--paper); }
  .tool-badge-write { background: rgba(255,255,255,0.2); }
  .tool-write .tool-path { color: rgba(255,255,255,0.8); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .tool-write pre { background: rgba(42,157,143,0.04); color: var(--ink); }
  /* Edit */
  .tool-edit { border: 1px solid rgba(244,162,97,0.4); }
  .tool-edit .tool-header { background: var(--yellow); color: var(--ink); }
  .tool-badge-edit { background: rgba(0,0,0,0.12); }
  .tool-edit .tool-path { color: rgba(0,0,0,0.6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .diff-view { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .diff-old { background: rgba(230,57,70,0.07); padding: 0.6rem 0.8rem; font-size: 0.79em; line-height: 1.45; overflow-x: auto; }
  .diff-new { background: rgba(42,157,143,0.07); padding: 0.6rem 0.8rem; font-size: 0.79em; line-height: 1.45; overflow-x: auto; }
  .diff-old code, .diff-new code { font-family: var(--font-mono); }
  /* Todo */
  .tool-todo { border: 1px solid rgba(69,123,157,0.3); }
  .tool-todo .tool-header { background: var(--blue); color: var(--paper); }
  .tool-badge-todo { background: rgba(255,255,255,0.2); }
  .todo-list { list-style: none; padding: 0.5rem 0.75rem; }
  .todo-item { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.2rem 0; font-size: 0.88em; }
  .todo-icon { color: rgba(28,28,28,0.45); flex-shrink: 0; margin-top: 0.1em; }
  .todo-done span:last-child { text-decoration: line-through; opacity: 0.5; }
  .todo-active .todo-icon { color: var(--blue); }
  /* Suggest options */
  .tool-suggest { border: none; background: none; }
  .tool-suggest .tool-header { padding: 0.2rem 0; background: none; gap: 0.5rem; flex-wrap: wrap; }
  .tool-badge-suggest { background: rgba(28,28,28,0.07); color: rgba(28,28,28,0.4); font-size: 0.75em; font-style: italic; }
  .suggest-pills { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .suggest-pill {
    font-family: var(--font-body);
    font-size: 0.75em;
    padding: 0.2em 0.6em;
    border: 1px solid rgba(28,28,28,0.2);
    border-radius: 12px;
    color: rgba(28,28,28,0.55);
    background: rgba(28,28,28,0.03);
  }
  /* Generic tool */
  .tool-generic { border: 1px solid rgba(28,28,28,0.12); }
  .tool-generic .tool-header { background: rgba(28,28,28,0.05); }
  .tool-badge-generic { background: rgba(28,28,28,0.15); color: var(--ink); }
  .tool-generic .tool-path { color: rgba(28,28,28,0.55); font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .tool-generic pre { background: rgba(28,28,28,0.03); }
  /* Tool results — inlined inside tool blocks */
  .tool-result { margin: 0; border-top: 1px solid rgba(255,255,255,0.08); border-radius: 0; overflow: hidden; }
  .tool-result-label {
    display: block;
    cursor: pointer;
    font-family: var(--font-body);
    font-size: 0.82em;
    font-weight: 600;
    padding: 0.45rem 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    list-style: none;
    user-select: none;
  }
  .tool-result-label::-webkit-details-marker { display: none; }
  .tool-result-label::before { content: '▶ '; font-size: 0.7em; }
  .tool-result[open] .tool-result-label::before { content: '▼ '; }
  .tool-result-ok { border: 1px solid rgba(42,157,143,0.25); }
  .tool-result-ok .tool-result-label { background: rgba(42,157,143,0.12); color: var(--green); }
  .tool-result-ok pre { background: rgba(42,157,143,0.03); padding: 0.6rem 0.75rem; font-size: 0.78em; line-height: 1.4; overflow-x: auto; color: var(--ink); }
  .tool-result-error { border: 1px solid rgba(230,57,70,0.3); }
  .tool-result-error .tool-result-label { background: rgba(230,57,70,0.1); color: var(--red); }
  .tool-result-error pre { background: rgba(230,57,70,0.04); padding: 0.6rem 0.75rem; font-size: 0.78em; line-height: 1.4; overflow-x: auto; }
  .tool-result pre code { font-family: var(--font-mono); }
  /* Agent turns — collapsed intermediate work steps */
  .agent-turn {
    border-top: 1px solid rgba(28,28,28,0.06);
    padding-top: 0;
    margin-bottom: 0;
  }
  .agent-turn-summary {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.65rem 0 0.65rem 1.25rem;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .agent-turn-summary::-webkit-details-marker { display: none; }
  .agent-turn-summary::before { content: '▶ '; font-size: 0.6em; color: rgba(28,28,28,0.35); }
  .agent-turn[open] .agent-turn-summary::before { content: '▼ '; }
  .agent-working {
    font-family: var(--font-body);
    font-size: 0.72em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(28,28,28,0.35);
  }
  .agent-turn-desc { font-family: var(--font-body); font-size: 0.8em; color: rgba(28,28,28,0.35); }
  .agent-turn-body { padding-bottom: 0.5rem; }
  /* Divider between messages */
  .message + .message { border-top: 1px solid rgba(28,28,28,0.06); padding-top: 1.25rem; margin-top: 0; }
  .message-user + .message-user { border-top-color: rgba(28,28,28,0.1); }
  /* Inline image */
  .inline-image { max-width: 100%; height: auto; border: 1px solid rgba(28,28,28,0.1); border-radius: 3px; margin: 0.5rem 0; }
  /* Sticky nav */
  .sticky-nav {
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 1001;
    background: var(--ink);
    padding: 10px 20px;
    padding-top: calc(env(safe-area-inset-top, 0px) + 10px);
    padding-left: calc(env(safe-area-inset-left, 0px) + 20px);
    padding-right: calc(env(safe-area-inset-right, 0px) + 20px);
    display: flex;
    gap: 16px;
    align-items: center;
    font-family: var(--font-body);
    font-size: 13px;
    letter-spacing: 0.02em;
    border-bottom: 2px solid var(--yellow);
  }
  .nav-brand {
    font-family: var(--font-display);
    font-weight: 900;
    font-size: 1em;
    color: var(--paper);
    white-space: nowrap;
  }
  .nav-sep { color: rgba(255,255,255,0.2); }
  .nav-session {
    color: rgba(255,255,255,0.45);
    font-size: 0.88em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .nav-jfdi-link {
    margin-left: auto;
    font-family: var(--font-display);
    font-weight: 900;
    font-size: 0.82em;
    color: var(--yellow);
    text-decoration: none;
    white-space: nowrap;
    opacity: 0.85;
    transition: opacity 0.15s;
  }
  .nav-jfdi-link:hover { opacity: 1; }
  .nav-spacer { height: calc(env(safe-area-inset-top, 0px) + 44px); }
  /* Metadata widget */
  .session-meta {
    background: rgba(28,28,28,0.04);
    border: 1px solid rgba(28,28,28,0.1);
    border-radius: 4px;
    padding: 0.6rem 1rem;
    margin-bottom: 2rem;
    font-size: 0.88em;
    line-height: 1.45;
    color: rgba(28,28,28,0.6);
  }
  /* Footer */
  .page-footer {
    margin-top: 3rem;
    padding: 1.25rem 0 0.5rem;
    border-top: 2px solid var(--ink);
    font-size: 0.78em;
    color: rgba(28,28,28,0.45);
    text-align: center;
    letter-spacing: 0.02em;
  }
  .footer-mark {
    display: inline-block;
    font-family: var(--font-display);
    font-weight: 900;
    font-size: 1.1em;
    color: var(--red);
    margin-right: 0.15em;
  }
  /* Selected button — user clicked a choice from offered options */
  .selected-button-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3em;
    font-family: var(--font-body);
    font-size: 0.82em;
    font-weight: 600;
    padding: 0.3em 0.85em;
    border: 2px solid var(--ink);
    border-radius: 12px;
    color: var(--paper);
    background: var(--ink);
  }
  @media (max-width: 600px) {
    .page { padding: 1.5rem 1rem 3rem; }
    .diff-view { grid-template-columns: 1fr; }
  }
`;

// ─── Entry Grouping ────────────────────────────────────────────────────────

function isToolOnlyAssistant(entry: Entry): boolean {
  if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) return false;
  const blocks = entry.message.content as ContentBlock[];
  return !blocks.some((b) => b.type === "text" && (b.text || "").trim());
}

function isToolResultOnlyUser(entry: Entry): boolean {
  if (entry.type !== "user" || !Array.isArray(entry.message?.content)) return false;
  return (entry.message.content as ContentBlock[]).every((b) => b.type === "tool_result");
}

function renderToolOnlyGroup(group: Entry[], resultIndex: Map<string, ContentBlock>): string {
  const allToolNames: string[] = [];
  for (const entry of group) {
    for (const b of (entry.message?.content as ContentBlock[] || [])) {
      if (b.type === "tool_use") allToolNames.push(b.name || "tool");
    }
  }
  const uniqueTools = [...new Set(allToolNames)];
  const stepCount = allToolNames.length;

  // "Bash × 11", "Read, Bash, Edit", or "12 calls"
  let summary: string;
  if (uniqueTools.length === 1) {
    summary = stepCount > 1 ? `${uniqueTools[0]} × ${stepCount}` : uniqueTools[0];
  } else if (uniqueTools.length <= 3) {
    summary = uniqueTools.join(", ") + (stepCount > uniqueTools.length ? ` (${stepCount})` : "");
  } else {
    summary = `${stepCount} tool calls`;
  }

  const time = (group[group.length - 1].timestamp)
    ? new Date(group[group.length - 1].timestamp!).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

  const body = group.map((entry) =>
    (entry.message?.content as ContentBlock[] || []).map((b) => renderBlock(b, resultIndex)).join("")
  ).join("");

  if (!body.trim()) return "";

  return `<details class="agent-turn">
    <summary class="agent-turn-summary">
      <span class="agent-working">Working</span>
      <span class="agent-turn-desc">${esc(summary)}</span>
      ${time ? `<span class="msg-time">${esc(time)}</span>` : ""}
    </summary>
    <div class="agent-turn-body">${body}</div>
  </details>`;
}

function isLaunchingSkillResult(entry: Entry): string | null {
  if (!isToolResultOnlyUser(entry)) return false;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return false;
  for (const b of content) {
    const inner = b.content;
    let text = "";
    if (typeof inner === "string") text = inner;
    else if (Array.isArray(inner)) text = inner.find((ib) => typeof ib.text === "string")?.text ?? "";
    const m = text.match(/^Launching skill:\s*(.+)/);
    if (m) return m[1].trim();
  }
  return null;
}

function renderEntries(entries: Entry[], resultIndex: Map<string, ContentBlock>): string {
  const parts: string[] = [];
  let i = 0;
  let pendingSuggestLabels: string[] | null = null;
  let pendingSkillName: string | null = null;

  while (i < entries.length) {
    const entry = entries[i];
    // Skip pure tool-result user turns (inlined into tool blocks)
    if (isToolResultOnlyUser(entry)) {
      const skillName = isLaunchingSkillResult(entry);
      if (skillName) pendingSkillName = skillName;
      i++;
      continue;
    }
    // Render command/skill expansion as collapsed block instead of as a YOU message
    if (pendingSkillName && entry.type === "user") {
      const content = entry.message?.content;
      const isTextOnly = Array.isArray(content) && content.every((b: ContentBlock) => b.type === "text");
      if (isTextOnly) {
        let text = (content as ContentBlock[]).map((b) => b.text || "").join("\n");
        // Strip "Base directory for this skill: /path" header line
        text = text.replace(/^Base directory for this skill:[^\n]*\n?/, "").trimStart();
        const skillLabel = pendingSkillName;
        pendingSkillName = null;
        parts.push(`<details class="agent-turn">
  <summary class="agent-turn-summary">
    <span class="agent-working">Skill</span>
    <span class="agent-turn-desc">${esc(skillLabel)}</span>
  </summary>
  <div class="agent-turn-body"><div class="text-block">${renderMd(text)}</div></div>
</details>`);
        i++;
        continue;
      }
      pendingSkillName = null;
    }
    // Group consecutive tool-only assistant turns into one collapsible
    // Skip the interleaved user tool-result turns while grouping
    if (isToolOnlyAssistant(entry)) {
      const group: Entry[] = [];
      while (i < entries.length) {
        if (isToolOnlyAssistant(entries[i])) {
          group.push(entries[i++]);
        } else if (isToolResultOnlyUser(entries[i])) {
          const sn = isLaunchingSkillResult(entries[i]); if (sn) pendingSkillName = sn;
          i++; // skip tool-result turns between work steps
        } else {
          break;
        }
      }
      // Track any suggest-options labels offered in this group
      for (const e of group) {
        const labels = extractSuggestLabelsFromEntry(e);
        if (labels.length > 0) { pendingSuggestLabels = labels; break; }
      }
      const html = renderToolOnlyGroup(group, resultIndex);
      if (html) parts.push(html);
      continue;
    }

    // Check if this user message is a button selection from the previous suggest-options
    if (entry.type === "user" && pendingSuggestLabels) {
      const text = extractUserText(entry.message?.content ?? "");
      if (!text) {
        // Filtered/empty message (e.g. session-resume inject) — keep labels active
        i++;
        continue;
      }
      const matchedLabel = pendingSuggestLabels.find(
        (l) => l.toLowerCase() === text.toLowerCase()
      );
      if (matchedLabel) {
        const html = renderButtonSelection(entry, matchedLabel);
        if (html) parts.push(html);
        pendingSuggestLabels = null;
        i++;
        continue;
      }
      pendingSuggestLabels = null; // not a match — reset
    }

    // Track suggest-options in mixed assistant turns (text + tool)
    if (entry.type === "assistant") {
      const labels = extractSuggestLabelsFromEntry(entry);
      if (labels.length > 0) pendingSuggestLabels = labels;
    }

    const html = renderEntry(entry, resultIndex);
    if (html) parts.push(html);
    i++;
  }
  return parts.join("\n");
}

// ─── HTML Generator ────────────────────────────────────────────────────────

function generateHtml(filePath: string): string {
  const entries = parseTranscript(filePath);
  const title = getTitle(entries, filePath);
  const stat = fs.statSync(filePath);
  const dateStr = stat.mtime.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const msgCount = entries.filter((e) => e.type === "user" && !e.isMeta).length;

  const resultIndex = buildResultIndex(entries);
  const messages = renderEntries(entries, resultIndex);

  const shortDate = stat.mtime.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#1C1C1C">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>${esc(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;700&family=Fraunces:opsz,wght@9..144,400;9..144,700;9..144,900&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
  <nav class="sticky-nav">
    <span class="nav-brand">Session Share</span>
    <span class="nav-sep">·</span>
    <span class="nav-session">Session · ${esc(shortDate)}</span>
    <a class="nav-jfdi-link" href="https://jfdi.bot" target="_blank" rel="noopener">jfdi.bot</a>
  </nav>
  <div class="nav-spacer"></div>
  <div class="page">
    <h1 class="page-title">${esc(title)}</h1>
    <div class="session-meta">${dateStr} · ${msgCount} exchange${msgCount !== 1 ? "s" : ""} · ${path.basename(filePath)}</div>
    <div class="conversation">
      ${messages}
    </div>
    <div class="page-footer"><span class="footer-mark">S</span> claude-session-share · Claude Code Session Viewer</div>
  </div>
</body>
</html>`;
}

// ─── S3-Compatible Upload ───────────────────────────────────────────────────

async function uploadToS3(htmlPath: string, slug: string): Promise<string> {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");

  const bucket = process.env.S3_BUCKET;
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region = process.env.AWS_REGION || "us-east-1";
  const prefix = process.env.S3_PREFIX ?? "public/";

  if (!bucket) throw new Error("S3_BUCKET env var is required");
  if (!process.env.AWS_ACCESS_KEY_ID) throw new Error("AWS_ACCESS_KEY_ID env var is required");
  if (!process.env.AWS_SECRET_ACCESS_KEY) throw new Error("AWS_SECRET_ACCESS_KEY env var is required");

  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });

  const key = `${prefix}transcript-${slug}.html`;
  const body = fs.readFileSync(htmlPath);

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: "text/html",
    ACL: "public-read",
  }));

  if (process.env.S3_PUBLIC_URL) {
    return `${process.env.S3_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
  }
  if (endpoint) {
    const ep = new URL(endpoint);
    return `${ep.protocol}//${bucket}.${ep.host}/${key}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

// ─── Interactive Picker ────────────────────────────────────────────────────

async function pickFile(): Promise<string> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const files = Array.from(
    new Bun.Glob("**/*.jsonl").scanSync({ cwd: projectsDir, absolute: true })
  )
    .filter((f) => !path.basename(f).startsWith("agent-"))
    .map((f) => ({ path: f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 25);

  if (files.length === 0) throw new Error("No transcript files found");

  console.log("\nRecent sessions:\n");
  files.forEach((f, i) => {
    const rel = path.relative(projectsDir, f.path);
    const date = new Date(f.mtime).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    console.log(`  ${String(i + 1).padStart(2)}. [${date}] ${rel}`);
  });

  process.stdout.write("\nSelect session number: ");
  const input = await new Promise<string>((resolve) => {
    const rl = require("readline").createInterface({ input: process.stdin });
    rl.once("line", (line: string) => { rl.close(); resolve(line.trim()); });
  });

  const idx = parseInt(input, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= files.length) throw new Error("Invalid selection");
  return files[idx].path;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Parse --output <file> flag
  const outputFlagIdx = args.indexOf("--output");
  let outputPath: string | null = null;
  if (outputFlagIdx !== -1) {
    outputPath = args[outputFlagIdx + 1];
    if (!outputPath) throw new Error("--output requires a file path");
    args.splice(outputFlagIdx, 2);
  }

  const arg = args[0];
  const filePath = arg ? path.resolve(arg) : await pickFile();

  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  console.log(`\nRendering: ${path.basename(filePath)}`);

  const html = generateHtml(filePath);
  const slug = path.basename(filePath, ".jsonl").slice(0, 8);

  if (outputPath) {
    fs.writeFileSync(outputPath, html);
    console.log(`\n✓ Saved to ${outputPath}\n`);
  } else {
    const tmpFile = path.join(os.tmpdir(), `transcript-${Date.now()}.html`);
    fs.writeFileSync(tmpFile, html);
    console.log("Uploading to S3...");
    const url = await uploadToS3(tmpFile, slug);
    fs.unlinkSync(tmpFile);
    console.log(`\n✓ ${url}\n`);
  }
}

main().catch((err) => { console.error("Error:", err.message); process.exit(1); });
