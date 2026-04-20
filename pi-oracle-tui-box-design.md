# pi-oracle TUI Box Design Spec

## Goal

Make `pi-oracle` feel like its own nested subagent inside `pi-coding-agent`, instead of rendering like normal inline tool text.

The Oracle should appear as a distinct bordered TUI box in both collapsed and expanded states. Normal tools can stay inline/plain, but Oracle gets a dedicated visual container because it represents a high-reasoning nested agent/subprocess.

Design principle:

> Oracle gets borders; normal tools do not.

This makes Oracle feel special, intentional, and clearly separate from regular tool calls.

---

## Visual Style

Use Unicode box drawing characters:

```txt
╭─ title ──────────────────────────────────────────────────────────────╮
│ content                                                              │
╰──────────────────────────────────────────────────────────────────────╯
```

Use these glyphs for status:

| State | Glyph | Label |
| --- | --- | --- |
| Starting / queued | `·` or `◌` | `starting` |
| Running / thinking / analyzing | animated spinner | `thinking`, `analyzing`, `working` |
| Done | `✓` | `finished` |
| Error | `✗` | `failed` |
| Cancelled | `■` | `cancelled` |

Recommended spinner frames:

```ts
const ORACLE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
```

Spinner timing:

```ts
const frame = ORACLE_SPINNER[Math.floor(Date.now() / 90) % ORACLE_SPINNER.length];
```

The spinner should feel smooth and premium. Prefer around `80–120ms` per frame if the TUI repaint loop allows it.

If actual repaint frequency is controlled by `onUpdate`, keep content update throttling as-is, but compute the spinner frame from `Date.now()` during render so it advances whenever pi repaints.

---

## Collapsed State

Collapsed Oracle output should still be a box, not inline text.

### Running / analyzing

```txt
╭─ ⠹ Oracle · analyzing ───────────────────────────────────────────────╮
│ Performance review                                                   │
│ ⎿ using read(MessageInput.tsx) · 1 turn · 295.7k↓ 290↑ · $0.0128      │
│                                                    Ctrl+O to expand  │
╰──────────────────────────────────────────────────────────────────────╯
```

### Done

```txt
╭─ ✓ Oracle · finished ────────────────────────────────────────────────╮
│ Performance review                                                   │
│ ⎿ 4 turns · 8 tool uses · 318.2k tokens · $0.0184                    │
│                                                    Ctrl+O to expand  │
╰──────────────────────────────────────────────────────────────────────╯
```

### Failed

```txt
╭─ ✗ Oracle · failed ──────────────────────────────────────────────────╮
│ Performance review                                                   │
│ ⎿ Oracle process exited with code 1                                  │
│                                                    Ctrl+O for details │
╰──────────────────────────────────────────────────────────────────────╯
```

### Cancelled

```txt
╭─ ■ Oracle · cancelled ───────────────────────────────────────────────╮
│ Performance review                                                   │
│ ⎿ cancelled by user                                                  │
│                                                    Ctrl+O for details │
╰──────────────────────────────────────────────────────────────────────╯
```

### Collapsed behavior

Collapsed box should show:

1. Oracle status in the title line.
2. Short task/description line.
3. Current activity or final summary line prefixed with `⎿`.
4. Usage/cost stats when available.
5. A subtle bottom-right hint: `Ctrl+O to expand`, `Ctrl+O for details`, etc.

The hint should be visually subtle, ideally dim/muted.

---

## Expanded State

Expanded Oracle output should show structured metadata, trace activity, and answer preview/full answer.

### Running / analyzing

```txt
╭─ ⠹ Oracle · analyzing ───────────────────────────────────────────────╮
│ Task    Performance review                                           │
│ Now     using read(MessageInput.tsx)                                  │
│ Model   openai-codex/gpt-5.4 · high                                  │
│ Usage   1 turn · 295.7k input · 290 output · $0.0128                  │
│                                                    Ctrl+O to collapse │
├─ Trace ──────────────────────────────────────────────────────────────┤
│ ✓ read   src/components/MessageInput.tsx                             │
│ ✓ grep   "stream"                                                    │
│ ⠹ read   convex/messages.ts                                          │
│ · grep   "provider routing"                                          │
├─ Answer ─────────────────────────────────────────────────────────────┤
│ The likely bottleneck is render/write amplification during streaming. │
│ Batch token updates and avoid per-token persistence on the hot path.  │
╰──────────────────────────────────────────────────────────────────────╯
```

### Done / finished

```txt
╭─ ✓ Oracle · finished ────────────────────────────────────────────────╮
│ Task    Performance review                                           │
│ Model   openai-codex/gpt-5.4 · high                                  │
│ Usage   4 turns · 318.2k tokens · $0.0184                             │
│                                                    Ctrl+O to collapse │
├─ Trace ──────────────────────────────────────────────────────────────┤
│ ✓ read   src/components/MessageInput.tsx                             │
│ ✓ grep   "stream"                                                    │
│ ✓ read   convex/messages.ts                                          │
│ ✓ grep   "provider routing"                                          │
├─ Answer ─────────────────────────────────────────────────────────────┤
│ TL;DR: batch token updates, avoid per-token Convex writes, and memoize│
│ model capability routing on the hot path.                            │
╰──────────────────────────────────────────────────────────────────────╯
```

### Failed / error

```txt
╭─ ✗ Oracle · failed ──────────────────────────────────────────────────╮
│ Task    Performance review                                           │
│ Model   openai-codex/gpt-5.4 · high                                  │
│ Error   Oracle process exited with code 1                             │
│                                                    Ctrl+O to collapse │
├─ Trace ──────────────────────────────────────────────────────────────┤
│ ✓ read   src/components/MessageInput.tsx                             │
│ ✗ grep   "stream"                                                    │
│   timeout while searching                                             │
├─ Details ────────────────────────────────────────────────────────────┤
│ Oracle process exited with code 1                                     │
╰──────────────────────────────────────────────────────────────────────╯
```

---

## Section Behavior

The outer Oracle box should use pi's existing tool expansion behavior.

- Collapsed state: `expanded === false`
- Expanded state: `expanded === true`
- User toggles with `Ctrl+O`

Inner sections like `Trace`, `Answer`, `Details`, or `Reasoning` do not need to be independently collapsible for the first implementation.

Avoid fake inner collapsible arrows unless they actually work. If sections are not clickable, use section separators instead of `▸` / `▾` arrows.

Good:

```txt
├─ Trace ──────────────────────────────────────────────────────────────┤
```

Avoid unless interactive:

```txt
▾ Trace
▸ Answer
```

---

## Content Rules

### Title line

Title format:

```txt
╭─ <glyph> Oracle · <status/activity> ─────────╮
```

Examples:

```txt
╭─ ⠹ Oracle · analyzing ───────────────────────╮
╭─ ⠋ Oracle · thinking ────────────────────────╮
╭─ ✓ Oracle · finished ────────────────────────╮
╭─ ✗ Oracle · failed ──────────────────────────╮
```

Status/activity labels should be short:

- `starting`
- `thinking`
- `analyzing`
- `working`
- `reading`
- `searching`
- `drafting`
- `finished`
- `failed`
- `cancelled`

Prefer a human-readable activity over raw internal status when possible.

### Task line

Collapsed:

```txt
│ Performance review                                                   │
```

Expanded:

```txt
│ Task    Performance review                                           │
```

Use the task itself or a short derived description. Truncate to fit available width.

### Activity line

Use `⎿` for subagent activity/result preview in collapsed mode:

```txt
│ ⎿ using read(MessageInput.tsx) · 1 turn · 295.7k↓ 290↑ · $0.0128      │
```

Expanded mode should use a named metadata row:

```txt
│ Now     using read(MessageInput.tsx)                                  │
```

### Usage formatting

Collapsed compact usage:

```txt
1 turn · 295.7k↓ 290↑ · $0.0128
```

Expanded usage:

```txt
1 turn · 295.7k input · 290 output · $0.0128
```

Optional additions when available:

```txt
cache 128k
8 tool uses
2m 14s
```

Examples:

```txt
4 turns · 8 tool uses · 318.2k tokens · $0.0184
1 turn · 295.7k input · 290 output · cache 128k · $0.0128
```

### Trace rows

Trace rows should be compact and aligned:

```txt
│ ✓ read   src/components/MessageInput.tsx                             │
│ ✓ grep   "stream"                                                    │
│ ⠹ read   convex/messages.ts                                          │
│ · grep   "provider routing"                                          │
```

Tool status glyphs:

| Tool state | Glyph |
| --- | --- |
| queued | `·` |
| running | spinner frame, same as Oracle spinner |
| done | `✓` |
| error | `✗` |
| cancelled | `■` |

Tool name alignment:

```txt
✓ read   path
✓ grep   query
✓ find   pattern
✓ ls     path
```

For tool input, use concise display strings:

```txt
read   src/components/MessageInput.tsx
grep   "stream"
find   "src/**/*.ts"
ls     src/
web    "query text"
```

Do not dump large JSON arguments in the box.

---

## Wrapping and Width

The box should adapt to terminal width if possible.

Suggested behavior:

- Use available render width from pi/TUI if exposed.
- If not exposed, use a reasonable default like `78` columns.
- Minimum useful width: around `50` columns.
- Truncate long single-line metadata rows with `…`.
- Wrap answer text inside the box.
- Keep left/right padding at 1 space after border.

Example content width for a 78-column box:

```txt
╭─ title ──────────────────────────────────────────────────────────────╮
│ <content width is approximately 68 chars>                             │
╰──────────────────────────────────────────────────────────────────────╯
```

Implementation helper idea:

```ts
function line(content: string, width: number): string {
  const innerWidth = width - 4; // border + spaces
  const clipped = truncateOrPad(content, innerWidth);
  return `│ ${clipped} │`;
}
```

Section divider helper:

```ts
function section(title: string, width: number): string {
  const label = `├─ ${title} `;
  const right = "┤";
  const fill = "─".repeat(Math.max(1, width - label.length - right.length));
  return `${label}${fill}${right}`;
}
```

Header helper:

```ts
function header(title: string, width: number): string {
  const left = `╭─ ${title} `;
  const right = "╮";
  const fill = "─".repeat(Math.max(1, width - left.length - right.length));
  return `${left}${fill}${right}`;
}
```

Footer helper:

```ts
function footer(width: number): string {
  return `╰${"─".repeat(width - 2)}╯`;
}
```

---

## Theme / Color Suggestions

Use existing pi theme colors where possible.

Suggested mapping:

| Element | Theme color idea |
| --- | --- |
| Border | muted/dim |
| Oracle title | toolTitle / bold |
| Running spinner | warning/accent |
| Done glyph | success |
| Error glyph | error |
| Cancelled glyph | dim |
| Metadata labels | muted |
| Metadata values | normal |
| Hint text | dim |
| Trace result previews | dim |
| Answer text | normal/toolOutput |

The box should still look good without color.

---

## Integration Notes for Existing `pi-oracle`

Current `pi-oracle` already has most of the data needed:

- `OracleDetails.status`
- `OracleDetails.model`
- `OracleDetails.thinking`
- `OracleDetails.files`
- `OracleDetails.missingFiles`
- `OracleDetails.transcript`
- `OracleDetails.finalAnswer`
- `OracleDetails.errorMessage`
- `OracleDetails.usage`
- `OracleToolUse.status`
- `OracleToolUse.name`
- `OracleToolUse.input`
- `OracleToolUse.resultPreview`
- `OracleToolUse.errorPreview`

Replace or refactor these render functions:

```ts
renderOracleCollapsed(...)
renderOracleExpanded(...)
statusGlyph(...)
```

The `renderResult` structure can stay the same:

```ts
renderResult(result, { expanded, isPartial }, theme, context) {
  const text = textFromResult(result);
  const details = normalizeOracleDetails(result.details, text);
  const params = context.args as OracleParams;

  if (expanded) {
    return new Text(renderOracleExpanded(params, details, text, isPartial, theme), 0, 0);
  }

  return new Text(renderOracleCollapsed(params, details, text, isPartial, theme), 0, 0);
}
```

The key visual change is that both collapsed and expanded renderers should return a full bordered box string.

---

## Pseudocode Sketch

```ts
const ORACLE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function statusGlyph(details: OracleDetails): string {
  if (details.status === "done") return "✓";
  if (details.status === "error") return "✗";
  if (details.status === "cancelled") return "■";
  if (details.status === "starting") return "·";
  return ORACLE_SPINNER[Math.floor(Date.now() / 90) % ORACLE_SPINNER.length] ?? "⠋";
}

function statusLabel(details: OracleDetails): string {
  if (details.status === "done") return "finished";
  if (details.status === "error") return "failed";
  if (details.status === "cancelled") return "cancelled";
  if (details.status === "starting") return "starting";
  return currentActivity(details); // e.g. analyzing, thinking, using read(...)
}

function renderOracleCollapsed(params, details, text, isPartial, theme): string {
  const width = 78;
  const glyph = statusGlyph(details);
  const label = shortStatusLabel(details);
  const title = `${glyph} Oracle · ${label}`;
  const task = shortTask(params, details);
  const activity = collapsedActivityLine(details, text);
  const hint = details.status === "error" || details.status === "cancelled"
    ? "Ctrl+O for details"
    : "Ctrl+O to expand";

  return [
    header(title, width),
    line(task, width),
    line(`⎿ ${activity}`, width),
    lineRight(hint, width),
    footer(width),
  ].join("\n");
}

function renderOracleExpanded(params, details, text, isPartial, theme): string {
  const width = 78;
  const glyph = statusGlyph(details);
  const label = shortStatusLabel(details);
  const title = `${glyph} Oracle · ${label}`;

  const lines = [
    header(title, width),
    lineKV("Task", shortTask(params, details), width),
  ];

  if (details.status !== "done" && details.status !== "error") {
    lines.push(lineKV("Now", currentActivity(details), width));
  }

  lines.push(lineKV("Model", `${details.model} · ${details.thinking}`, width));
  lines.push(lineKV("Usage", expandedUsage(details.usage), width));
  lines.push(lineRight("Ctrl+O to collapse", width));

  lines.push(section("Trace", width));
  for (const tool of visibleTools(details)) {
    lines.push(line(formatTraceTool(tool), width));
  }

  if (details.status === "error") {
    lines.push(section("Details", width));
    lines.push(...wrapBoxText(details.errorMessage ?? "Oracle failed", width));
  } else {
    lines.push(section("Answer", width));
    lines.push(...wrapBoxText(answerPreview(details, text), width));
  }

  lines.push(footer(width));
  return lines.join("\n");
}
```

---

## Acceptance Criteria

- Oracle collapsed result renders as a bordered box.
- Oracle expanded result renders as a larger bordered box with metadata, trace, and answer/details sections.
- Collapsed state includes `Ctrl+O to expand` or `Ctrl+O for details`.
- Expanded state includes `Ctrl+O to collapse`.
- Running Oracle uses a smooth Braille spinner.
- Done/error/cancelled states use stable status glyphs.
- Tool rows show queued/running/done/error state clearly.
- Long task/activity/tool/answer text is clipped or wrapped inside the box, never spilling ugly into the transcript.
- Normal tools remain visually simpler; Oracle is the special bordered subagent box.
