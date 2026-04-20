import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const ORACLE_MODEL = process.env.PI_ORACLE_MODEL || "openai-codex/gpt-5.4";
const ORACLE_THINKING = process.env.PI_ORACLE_THINKING || "high";
const ORACLE_TOOLS = process.env.PI_ORACLE_TOOLS || "read,grep,find,ls,web_search,read_web_page,find_thread,read_thread";
const WEB_TOOLS_EXTENSION = path.join(path.dirname(fileURLToPath(import.meta.url)), "web-tools.ts");

const ORACLE_SYSTEM_PROMPT = `You are the Oracle - an expert AI advisor with advanced reasoning capabilities.

Your role is to provide high-quality technical guidance, code reviews, architectural advice, and strategic planning for software engineering tasks.

You are a subagent inside an AI coding system, called when the main agent needs a smarter, more capable model. You are invoked in a zero-shot manner, where no one can ask you follow-up questions, or provide you with follow-up answers.

Key responsibilities:
- Analyze code and architecture patterns
- Provide specific, actionable technical recommendations
- Plan implementations and refactoring strategies
- Answer deep technical questions with clear reasoning
- Suggest best practices and improvements
- Identify potential issues and propose solutions

Operating principles (simplicity-first):
- Default to the simplest viable solution that meets the stated requirements and constraints.
- Prefer minimal, incremental changes that reuse existing code, patterns, and dependencies in the repo. Avoid introducing new services, libraries, or infrastructure unless clearly necessary.
- Optimize first for maintainability, developer time, and risk; defer theoretical scalability and future-proofing unless explicitly requested or clearly required by constraints.
- Apply YAGNI and KISS; avoid premature optimization.
- Provide one primary recommendation. Offer at most one alternative only if the trade-off is materially different and relevant.
- Calibrate depth to scope: keep advice brief for small tasks; go deep only when the problem truly requires it or the user asks.
- Include a rough effort/scope signal, for example S <1h, M 1-3h, L 1-2d, XL >2d, when proposing changes.
- Stop when the solution is good enough. Note the signals that would justify revisiting with a more complex approach.

Tool usage:
- Use attached files and provided context first. Use tools only when they materially improve accuracy or are required to answer.
- You have read-only local tools: read, grep, find, and ls. Use find where Amp Oracle would use glob.
- You may use web_search, read_web_page, read_thread, and find_thread when local information is insufficient or a current reference is needed.
- Do not modify files. Do not ask the main agent to run a follow-up unless it is essential.

Response format:
1. TL;DR: 1-3 sentences with the recommended simple approach.
2. Recommended approach: numbered steps or a short checklist; include minimal diffs or code snippets only as needed.
3. Rationale and trade-offs: brief justification; mention why alternatives are unnecessary now.
4. Risks and guardrails: key caveats and how to mitigate them.
5. When to consider the advanced path: concrete triggers or thresholds that justify a more complex design.
6. Optional advanced path: include only if relevant, and keep it brief.

Guidelines:
- Use your reasoning to provide thoughtful, well-structured, and pragmatic advice.
- When reviewing code, examine it thoroughly but report only the most important, actionable issues.
- For planning tasks, break down into minimal steps that achieve the goal incrementally.
- Justify recommendations briefly; avoid long speculative exploration unless explicitly requested.
- Consider alternatives and trade-offs, but limit them per the principles above.
- Be thorough but concise. Focus on the highest-leverage insights.

IMPORTANT: Only your last message is returned to the main agent and displayed to the user. Your last message should be comprehensive yet focused, with a clear, simple recommendation that helps the user act immediately.`;

interface OracleParams {
	task: string;
	context?: string;
	files?: string[];
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	turns: number;
}

type OracleRunStatus = "starting" | "in-progress" | "done" | "error" | "cancelled";
type OracleToolStatus = "queued" | "in-progress" | "done" | "error" | "cancelled";

interface OracleToolUse {
	id: string;
	name: string;
	status: OracleToolStatus;
	input?: unknown;
	resultPreview?: string;
	errorPreview?: string;
	startedAt?: number;
	endedAt?: number;
}

interface OracleTranscriptTurn {
	id: string;
	message: string;
	reasoning: string;
	isThinking: boolean;
	toolUses: OracleToolUse[];
}

interface OracleDetails {
	status: OracleRunStatus;
	model: string;
	thinking: string;
	cwd: string;
	files: string[];
	missingFiles: string[];
	transcript: OracleTranscriptTurn[];
	currentTurnId?: string;
	finalAnswer: string;
	errorMessage?: string;
	usage: UsageStats;
	exitCode: number | null;
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

function normalizeUsage(rawUsage: unknown): UsageStats {
	if (!rawUsage || typeof rawUsage !== "object") return emptyUsage();
	const usage = rawUsage as Partial<UsageStats>;
	return {
		input: Number(usage.input ?? 0),
		output: Number(usage.output ?? 0),
		cacheRead: Number(usage.cacheRead ?? 0),
		cacheWrite: Number(usage.cacheWrite ?? 0),
		totalTokens: Number(usage.totalTokens ?? 0),
		cost: Number(usage.cost ?? 0),
		turns: Number(usage.turns ?? 0),
	};
}

function normalizeToolStatus(status: unknown): OracleToolStatus {
	if (status === "queued" || status === "in-progress" || status === "done" || status === "error" || status === "cancelled") {
		return status;
	}
	return "done";
}

function normalizeToolUse(rawTool: unknown, index: number): OracleToolUse {
	const tool = rawTool && typeof rawTool === "object" ? (rawTool as Partial<OracleToolUse>) : {};
	return {
		id: String(tool.id ?? `legacy-tool-${index}`),
		name: String(tool.name ?? "tool"),
		status: normalizeToolStatus(tool.status),
		input: tool.input,
		resultPreview: typeof tool.resultPreview === "string" ? tool.resultPreview : undefined,
		errorPreview: typeof tool.errorPreview === "string" ? tool.errorPreview : undefined,
		startedAt: typeof tool.startedAt === "number" ? tool.startedAt : undefined,
		endedAt: typeof tool.endedAt === "number" ? tool.endedAt : undefined,
	};
}

function normalizeTranscript(rawTranscript: unknown): OracleTranscriptTurn[] {
	if (!Array.isArray(rawTranscript)) return [];
	return rawTranscript.map((rawTurn, index) => {
		const turn = rawTurn && typeof rawTurn === "object" ? (rawTurn as Partial<OracleTranscriptTurn>) : {};
		return {
			id: String(turn.id ?? `turn-${index + 1}`),
			message: typeof turn.message === "string" ? turn.message : "",
			reasoning: typeof turn.reasoning === "string" ? turn.reasoning : "",
			isThinking: Boolean(turn.isThinking),
			toolUses: Array.isArray(turn.toolUses) ? turn.toolUses.map(normalizeToolUse) : [],
		};
	});
}

function normalizeOracleDetails(rawDetails: unknown, outputText: string): OracleDetails | undefined {
	if (!rawDetails || typeof rawDetails !== "object") return undefined;
	const raw = rawDetails as Record<string, unknown>;
	const transcript = normalizeTranscript(raw.transcript);

	if (transcript.length === 0) {
		const legacyMessage = typeof raw.currentMessage === "string" ? raw.currentMessage : outputText;
		const legacyReasoning = typeof raw.currentReasoning === "string" ? raw.currentReasoning : "";
		const legacyTools = Array.isArray(raw.activeTools) ? raw.activeTools.map(normalizeToolUse) : [];
		if (legacyMessage || legacyReasoning || legacyTools.length > 0) {
			transcript.push({
				id: "legacy-turn-1",
				message: legacyMessage,
				reasoning: legacyReasoning,
				isThinking: Boolean(raw.isThinking),
				toolUses: legacyTools,
			});
		}
	}

	const rawStatus = raw.status;
	const status: OracleRunStatus =
		rawStatus === "starting" || rawStatus === "in-progress" || rawStatus === "done" || rawStatus === "error" || rawStatus === "cancelled"
			? rawStatus
			: outputText.trim()
				? "done"
				: "in-progress";

	return {
		status,
		model: String(raw.model ?? ORACLE_MODEL),
		thinking: String(raw.thinking ?? ORACLE_THINKING),
		cwd: String(raw.cwd ?? process.cwd()),
		files: Array.isArray(raw.files) ? raw.files.filter((file): file is string => typeof file === "string") : [],
		missingFiles: Array.isArray(raw.missingFiles)
			? raw.missingFiles.filter((file): file is string => typeof file === "string")
			: [],
		transcript,
		currentTurnId: typeof raw.currentTurnId === "string" ? raw.currentTurnId : transcript.at(-1)?.id,
		finalAnswer: typeof raw.finalAnswer === "string" ? raw.finalAnswer : outputText,
		errorMessage: typeof raw.errorMessage === "string" ? raw.errorMessage : undefined,
		usage: normalizeUsage(raw.usage),
		exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
	};
}

function normalizeExtensionPath(filePath: string): string {
	if (process.platform === "win32" && filePath.startsWith("/") && /^[A-Za-z]:/.test(filePath.slice(1, 3))) {
		return filePath.slice(1);
	}
	return filePath;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function resolveOracleFile(cwd: string, rawFile: string): string {
	let file = rawFile.trim();
	if (file.startsWith("@")) file = file.slice(1);
	if (file.startsWith("~/") || file === "~") {
		file = path.join(os.homedir(), file.slice(2));
	}
	return path.resolve(cwd, file);
}

function textFromMessage(message: Message | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function accumulateUsage(usage: UsageStats, message: Message) {
	if (message.role !== "assistant" || !message.usage) return;
	const anyUsage = message.usage as any;
	usage.input += Number(anyUsage.input ?? 0);
	usage.output += Number(anyUsage.output ?? 0);
	usage.cacheRead += Number(anyUsage.cacheRead ?? 0);
	usage.cacheWrite += Number(anyUsage.cacheWrite ?? 0);
	usage.totalTokens += Number(anyUsage.totalTokens ?? 0);
	usage.cost += Number(anyUsage.cost?.total ?? anyUsage.cost ?? 0);
}

function truncateText(text: string, maxLength: number): string {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength).trimEnd()}\n... (${normalized.length - maxLength} more chars)`;
}

function truncateOneLine(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatToolInput(toolName: string, input: unknown): string {
	if (!input || typeof input !== "object") return toolName;
	const args = input as Record<string, unknown>;
	switch (toolName) {
		case "read":
		case "Read":
			return typeof args.path === "string" ? `${toolName}(${args.path})` : toolName;
		case "grep":
		case "Grep": {
			const pattern = typeof args.pattern === "string" ? `"${truncateOneLine(args.pattern, 80)}"` : "";
			const pathText = typeof args.path === "string" ? ` in ${args.path}` : "";
			return pattern ? `${toolName}(${pattern}${pathText})` : toolName;
		}
		case "find":
		case "glob": {
			const pattern = typeof args.pattern === "string" ? args.pattern : typeof args.filePattern === "string" ? args.filePattern : "";
			return pattern ? `${toolName}("${truncateOneLine(pattern, 100)}")` : toolName;
		}
		case "ls":
			return typeof args.path === "string" ? `${toolName}(${args.path})` : toolName;
		case "web_search":
			return typeof args.query === "string" ? `${toolName}("${truncateOneLine(args.query, 100)}")` : toolName;
		case "read_web_page":
			return typeof args.url === "string" ? `${toolName}(${truncateOneLine(args.url, 120)})` : toolName;
		case "find_thread":
			return typeof args.query === "string" ? `${toolName}("${truncateOneLine(args.query, 100)}")` : toolName;
		case "read_thread":
			return typeof args.thread === "string" ? `${toolName}(${truncateOneLine(args.thread, 120)})` : toolName;
		default: {
			const json = JSON.stringify(input);
			return json && json !== "{}" ? `${toolName} ${truncateOneLine(json, 140)}` : toolName;
		}
	}
}

function getCurrentTurn(details: OracleDetails): OracleTranscriptTurn {
	const current = details.transcript.find((turn) => turn.id === details.currentTurnId);
	if (current) return current;

	const turn: OracleTranscriptTurn = {
		id: `turn-${details.transcript.length + 1}`,
		message: "",
		reasoning: "",
		isThinking: false,
		toolUses: [],
	};
	details.transcript.push(turn);
	details.currentTurnId = turn.id;
	return turn;
}

function startTranscriptTurn(details: OracleDetails): OracleTranscriptTurn {
	const turn: OracleTranscriptTurn = {
		id: `turn-${details.transcript.length + 1}`,
		message: "",
		reasoning: "",
		isThinking: true,
		toolUses: [],
	};
	details.transcript.push(turn);
	details.currentTurnId = turn.id;
	return turn;
}

function upsertToolUse(details: OracleDetails, tool: OracleToolUse) {
	const turn = getCurrentTurn(details);
	const existingIndex = turn.toolUses.findIndex((item) => item.id === tool.id);
	if (existingIndex >= 0) {
		const existing = turn.toolUses[existingIndex];
		turn.toolUses[existingIndex] = { ...existing, ...tool, input: tool.input ?? existing.input };
	} else {
		turn.toolUses.push(tool);
	}
}

function getAllToolUses(details: OracleDetails): OracleToolUse[] {
	return details.transcript.flatMap((turn) => turn.toolUses);
}

function getActiveToolUses(details: OracleDetails): OracleToolUse[] {
	return getAllToolUses(details).filter((tool) => tool.status === "queued" || tool.status === "in-progress");
}

function getLatestTurn(details: OracleDetails): OracleTranscriptTurn | undefined {
	return details.transcript.at(-1);
}

function resultPreview(result: unknown, maxLength = 800): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text ? truncateText(text, maxLength) : undefined;
}

function formatTokens(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "";
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`in ${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`out ${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`cache ${formatTokens(usage.cacheRead)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

function currentActivity(details: OracleDetails): string {
	if (details.status === "starting") return "starting nested pi";
	if (details.status === "done") return "finished";
	if (details.status === "error") return "failed";
	if (details.status === "cancelled") return "cancelled";

	const active = getActiveToolUses(details).at(-1);
	if (active) return `${active.status === "queued" ? "queued" : "using"} ${formatToolInput(active.name, active.input)}`;

	const latest = getLatestTurn(details);
	if (latest?.isThinking) return "thinking";
	if (latest?.message.trim()) return "drafting answer";
	return "working";
}

const ORACLE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function header(title: string, width: number): string {
	const left = `╭─ ${title} `;
	const right = "╮";
	const fill = "─".repeat(Math.max(1, width - left.length - right.length));
	return `${left}${fill}${right}`;
}

function footer(width: number): string {
	return `╰${"─".repeat(width - 2)}╯`;
}

function line(content: string, width: number): string {
	const innerWidth = width - 4;
	const clipped = content.length > innerWidth ? content.slice(0, innerWidth - 1) + "…" : content;
	const padded = clipped.padEnd(innerWidth);
	return `│ ${padded} │`;
}

function section(title: string, width: number): string {
	const label = `├─ ${title} `;
	const right = "┤";
	const fill = "─".repeat(Math.max(1, width - label.length - right.length));
	return `${label}${fill}${right}`;
}

function lineKV(label: string, value: string, width: number): string {
	const labelWidth = 8;
	const innerWidth = width - 4;
	const valueWidth = innerWidth - labelWidth - 1;
	const clippedValue = value.length > valueWidth ? value.slice(0, valueWidth - 1) + "…" : value;
	const paddedLabel = label.padEnd(labelWidth);
	const paddedValue = clippedValue.padEnd(valueWidth);
	return `│ ${paddedLabel} ${paddedValue} │`;
}

function lineRight(content: string, width: number): string {
	const innerWidth = width - 4;
	const padded = content.padStart(innerWidth);
	return `│ ${padded} │`;
}

function wrapBoxText(text: string, width: number): string[] {
	const innerWidth = width - 4;
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let currentLine = "";
	for (const word of words) {
		if (currentLine.length + word.length + 1 <= innerWidth) {
			currentLine += (currentLine ? " " : "") + word;
		} else {
			if (currentLine) lines.push(currentLine);
			currentLine = word.length > innerWidth ? word.slice(0, innerWidth - 1) + "…" : word;
		}
	}
	if (currentLine) lines.push(currentLine);
	return lines.map((l) => line(l, width));
}

function buildOracleProgressBody(params: OracleParams, details: OracleDetails): string {
	const activity = currentActivity(details);
	const usage = formatUsage(details.usage);
	const lines: string[] = [
		`Oracle ${activity}`,
		`Task: ${truncateOneLine(params.task, 180)}`,
		`Model: ${details.model} (${details.thinking} thinking)${usage ? `, ${usage}` : ""}`,
	];

	if (details.files.length > 0) {
		lines.push(`Files: ${details.files.map((file) => path.basename(file)).join(", ")}`);
	}
	if (details.missingFiles.length > 0) {
		lines.push(`Missing files: ${details.missingFiles.join(", ")}`);
	}

	const activeTools = getActiveToolUses(details);
	if (activeTools.length > 0) lines.push(`Active: ${activeTools.map((tool) => formatToolInput(tool.name, tool.input)).join("; ")}`);
	if (details.errorMessage) lines.push(`Error: ${truncateOneLine(details.errorMessage, 220)}`);
	return lines.join("\n");
}

function buildOraclePrompt(params: OracleParams, existingFiles: string[], missingFiles: string[]): string {
	const sections = [`## Task\n${params.task.trim()}`];
	if (params.context?.trim()) {
		sections.push(`## Context\n${params.context.trim()}`);
	}
	if (existingFiles.length > 0) {
		sections.push(`## Attached files\n${existingFiles.map((file) => `- ${file}`).join("\n")}`);
	}
	if (missingFiles.length > 0) {
		sections.push(`## Requested files that were not found\n${missingFiles.map((file) => `- ${file}`).join("\n")}`);
	}
	sections.push(
		"## Instructions\nAnswer as the Oracle. Use the attached files and read-only tools as needed, then return the final advisory response only.",
	);
	return sections.join("\n\n");
}

function createPartialResult(text: string, details: OracleDetails): AgentToolResult<OracleDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function textFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

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
	const activity = currentActivity(details);
	if (activity.includes("thinking")) return "thinking";
	if (activity.includes("analyzing")) return "analyzing";
	if (activity.includes("working")) return "working";
	if (activity.includes("reading")) return "reading";
	if (activity.includes("searching")) return "searching";
	if (activity.includes("drafting")) return "drafting";
	return "working";
}

function shortTask(params: OracleParams, details: OracleDetails): string {
	return truncateOneLine(params.task, 68);
}

function collapsedActivityLine(details: OracleDetails, text: string): string {
	if (details.status === "done") {
		const toolCount = getAllToolUses(details).length;
		const usage = details.usage;
		const parts: string[] = [];
		if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
		if (toolCount > 0) parts.push(`${toolCount} tool use${toolCount === 1 ? "" : "s"}`);
		if (usage.totalTokens) parts.push(`${formatTokens(usage.totalTokens)} tokens`);
		if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
		return parts.join(" · ");
	}
	if (details.status === "error") {
		return details.errorMessage || "Oracle process exited with code 1";
	}
	if (details.status === "cancelled") {
		return "cancelled by user";
	}
	const active = getActiveToolUses(details).at(-1);
	if (active) {
		const usage = details.usage;
		const parts: string[] = [`using ${formatToolInput(active.name, active.input)}`];
		if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
		if (usage.input) parts.push(`${formatTokens(usage.input)}↓`);
		if (usage.output) parts.push(`${formatTokens(usage.output)}↑`);
		if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
		return parts.join(" · ");
	}
	return currentActivity(details);
}

function expandedUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`${formatTokens(usage.input)} input`);
	if (usage.output) parts.push(`${formatTokens(usage.output)} output`);
	if (usage.cacheRead) parts.push(`cache ${formatTokens(usage.cacheRead)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

function toolStatusGlyph(tool: OracleToolUse): string {
	if (tool.status === "done") return "✓";
	if (tool.status === "error") return "✗";
	if (tool.status === "cancelled") return "■";
	if (tool.status === "queued") return "·";
	return ORACLE_SPINNER[Math.floor(Date.now() / 90) % ORACLE_SPINNER.length] ?? "⠋";
}

function formatTraceTool(tool: OracleToolUse): string {
	const glyph = toolStatusGlyph(tool);
	const toolName = tool.name.padEnd(6);
	const input = formatToolInput(tool.name, tool.input);
	return `${glyph} ${toolName} ${input}`;
}

function visibleTools(details: OracleDetails): OracleToolUse[] {
	return getAllToolUses(details).slice(0, 50);
}

function answerPreview(details: OracleDetails, text: string): string {
	if (details.status === "done" && details.finalAnswer) {
		return details.finalAnswer;
	}
	return text || "";
}

function renderOracleCollapsed(params: OracleParams, details: OracleDetails | undefined, text: string, isPartial: boolean, theme: any): string {
	if (!details) {
		return text || "Waiting for Oracle...";
	}

	const width = 78;
	const glyph = statusGlyph(details);
	const label = statusLabel(details);
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

function renderOracleExpanded(params: OracleParams, details: OracleDetails | undefined, text: string, isPartial: boolean, theme: any): string {
	if (!details) {
		return text || "Waiting for Oracle...";
	}

	const width = 78;
	const glyph = statusGlyph(details);
	const label = statusLabel(details);
	const title = `${glyph} Oracle · ${label}`;

	const lines: string[] = [
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

async function runOracle(
	params: OracleParams,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (partial: AgentToolResult<OracleDetails>) => void,
): Promise<AgentToolResult<OracleDetails>> {
	const runSignal = signal ?? new AbortController().signal;
	const requestedFiles = params.files ?? [];
	const existingFiles: string[] = [];
	const missingFiles: string[] = [];

	for (const requestedFile of requestedFiles) {
		const resolved = resolveOracleFile(cwd, requestedFile);
		if (fs.existsSync(resolved)) existingFiles.push(resolved);
		else missingFiles.push(requestedFile);
	}

	const details: OracleDetails = {
		status: "starting",
		model: ORACLE_MODEL,
		thinking: ORACLE_THINKING,
		cwd,
		files: existingFiles,
		missingFiles,
		transcript: [],
		finalAnswer: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
		exitCode: null,
	};

	const prompt = buildOraclePrompt(params, existingFiles, missingFiles);
	const args = [
		"--mode",
		"json",
		"--no-session",
		"--no-extensions",
		"-e",
		normalizeExtensionPath(WEB_TOOLS_EXTENSION),
		"--model",
		ORACLE_MODEL,
		"--thinking",
		ORACLE_THINKING,
		"--tools",
		ORACLE_TOOLS,
		"--system-prompt",
		ORACLE_SYSTEM_PROMPT,
		...existingFiles.map((file) => `@${file}`),
		prompt,
	];

	const invocation = getPiInvocation(args);
	let stdoutBuffer = "";
	let stderr = "";
	let finalText = "";
	let sawAgentEnd = false;
	let lastUpdateAt = 0;

	return await new Promise<AgentToolResult<OracleDetails>>((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const abort = () => {
			child.kill();
			reject(new Error("Oracle run aborted"));
		};
		if (runSignal.aborted) return abort();
		runSignal.addEventListener("abort", abort, { once: true });

		const emitUpdate = (force = false) => {
			const now = Date.now();
			if (!force && now - lastUpdateAt < 250) return;
			lastUpdateAt = now;
			const body = buildOracleProgressBody(params, details);
			onUpdate?.(createPartialResult(body, details));
		};

		emitUpdate(true);

		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "agent_start") {
				details.status = "in-progress";
				emitUpdate(true);
			} else if (event.type === "turn_start") {
				startTranscriptTurn(details);
				emitUpdate(true);
			} else if (event.type === "tool_execution_start") {
				const id = String(event.toolCallId ?? `${event.toolName}-${getAllToolUses(details).length}`);
				upsertToolUse(details, {
					id,
					name: String(event.toolName ?? "tool"),
					status: "in-progress",
					input: event.args,
					startedAt: Date.now(),
				});
				emitUpdate(true);
			} else if (event.type === "tool_execution_update") {
				const id = String(event.toolCallId ?? `${event.toolName}-${getAllToolUses(details).length}`);
				upsertToolUse(details, {
					id,
					name: String(event.toolName ?? "tool"),
					status: "in-progress",
					input: event.args,
					resultPreview: resultPreview(event.partialResult, 400),
				});
				emitUpdate();
			} else if (event.type === "tool_execution_end") {
				const id = String(event.toolCallId ?? `${event.toolName}-${getAllToolUses(details).length}`);
				const status: OracleToolStatus = event.isError ? "error" : "done";
				const existingTool = getAllToolUses(details).find((tool) => tool.id === id);
				const input = event.args ?? existingTool?.input;
				const preview = resultPreview(event.result);
				upsertToolUse(details, {
					id,
					name: String(event.toolName ?? existingTool?.name ?? "tool"),
					status,
					input,
					resultPreview: event.isError ? existingTool?.resultPreview : preview,
					errorPreview: event.isError ? preview : existingTool?.errorPreview,
					endedAt: Date.now(),
				});
				emitUpdate(true);
			} else if (event.type === "message_update") {
				const messageEvent = event.assistantMessageEvent;
				if (messageEvent?.type === "thinking_start") {
					const turn = getCurrentTurn(details);
					turn.reasoning = "";
					turn.isThinking = true;
					emitUpdate(true);
				} else if (messageEvent?.type === "thinking_delta") {
					const turn = getCurrentTurn(details);
					turn.reasoning += messageEvent.delta ?? "";
					turn.isThinking = true;
					emitUpdate();
				} else if (messageEvent?.type === "thinking_end") {
					const turn = getCurrentTurn(details);
					turn.reasoning = messageEvent.content ?? turn.reasoning;
					turn.isThinking = false;
					emitUpdate(true);
				} else if (messageEvent?.type === "text_start") {
					emitUpdate(true);
				} else if (messageEvent?.type === "text_delta") {
					const turn = getCurrentTurn(details);
					turn.message += messageEvent.delta ?? "";
					turn.isThinking = false;
					finalText = turn.message;
					emitUpdate();
				} else if (messageEvent?.type === "text_end") {
					const turn = getCurrentTurn(details);
					turn.message = messageEvent.content ?? turn.message;
					turn.isThinking = false;
					finalText = turn.message;
					emitUpdate(true);
				} else if (messageEvent?.type === "toolcall_start") {
					emitUpdate(true);
				} else if (messageEvent?.type === "toolcall_end") {
					const toolCall = messageEvent.toolCall;
					if (toolCall?.id && toolCall.name) {
						upsertToolUse(details, { id: toolCall.id, name: toolCall.name, status: "queued", input: toolCall.arguments });
						emitUpdate(true);
					}
				} else if (messageEvent?.type === "done") {
					const text = textFromMessage(messageEvent.message);
					if (text) {
						const turn = getCurrentTurn(details);
						turn.message = text;
						finalText = text;
					}
					emitUpdate(true);
				} else if (messageEvent?.type === "error") {
					details.status = "error";
					details.errorMessage = messageEvent.error?.errorMessage ?? "Oracle model stream failed";
					emitUpdate(true);
				}
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				const text = textFromMessage(event.message);
				if (text) {
					const turn = getCurrentTurn(details);
					turn.message = text;
					turn.isThinking = false;
					finalText = text;
				}
				accumulateUsage(details.usage, event.message);
				emitUpdate(true);
			} else if (event.type === "turn_end") {
				details.usage.turns++;
				const turn = getCurrentTurn(details);
				turn.isThinking = false;
				emitUpdate(true);
			} else if (event.type === "agent_end") {
				sawAgentEnd = true;
				const messages = Array.isArray(event.messages) ? event.messages : [];
				const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
				const text = textFromMessage(lastAssistant);
				if (text) finalText = text;
				details.finalAnswer = finalText;
				details.status = "done";
				const turn = getCurrentTurn(details);
				turn.isThinking = false;
				emitUpdate(true);
			}
		};

		child.stdout?.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			let newlineIndex = stdoutBuffer.indexOf("\n");
			while (newlineIndex >= 0) {
				const line = stdoutBuffer.slice(0, newlineIndex);
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				handleLine(line);
				newlineIndex = stdoutBuffer.indexOf("\n");
			}
		});

		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			runSignal.removeEventListener("abort", abort);
			reject(error);
		});

		child.on("close", (code) => {
			runSignal.removeEventListener("abort", abort);
			details.exitCode = code;
			if (stdoutBuffer.trim()) handleLine(stdoutBuffer);

			if (code !== 0) {
				details.status = "error";
				details.errorMessage = stderr.trim() || `Oracle process exited with code ${code}`;
				reject(new Error(details.errorMessage));
				return;
			}

			if (!sawAgentEnd && !finalText) {
				details.status = "error";
				details.errorMessage = stderr.trim() || "Oracle process ended without a final answer";
				reject(new Error(details.errorMessage));
				return;
			}

			details.status = "done";
			details.finalAnswer = finalText.trim() || "(Oracle returned no text.)";
			resolve(createPartialResult(details.finalAnswer, details));
		});
	});
}

export default function oracleExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "oracle",
		label: "Oracle",
		description: `Consult the oracle - an AI advisor powered by ${ORACLE_MODEL} with ${ORACLE_THINKING} reasoning that can plan, review, and provide expert guidance.

The oracle has read-only local tools plus web_search, read_web_page, read_thread, and find_thread. It is best for code reviews, architecture feedback, difficult bugs across many files, complex implementation/refactor planning, deep technical questions, and a second point of view when the main agent is stuck.

Do not use it for simple file reads/searches, codebase searches the main agent can do directly, web browsing/searching the main agent can do directly, bulk code execution, or code edits you can perform directly.`,
		promptSnippet: "oracle - Ask a GPT-5.4 high-reasoning advisor for reviews, plans, debugging help, and architecture trade-offs.",
		promptGuidelines: [
			"Use oracle for complex reviews, architecture decisions, deep debugging, refactoring plans, and high-stakes technical trade-off analysis.",
			"Prompt oracle with a precise question, relevant context, and specific files whenever you know them.",
			"Do not use oracle for simple file lookup, basic searches, web browsing, or direct code modification.",
		],
		parameters: Type.Object({
			task: Type.String({
				description:
					"The task or question you want the Oracle to help with. Be specific about what kind of guidance, review, or planning you need.",
			}),
			context: Type.Optional(
				Type.String({
					description:
						"Optional context about the current situation, what you have tried, or background information that would help the Oracle provide better guidance.",
				}),
			),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Optional list of specific file paths, including images, that the Oracle should examine. Relative paths are resolved from the current working directory.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return runOracle(params as OracleParams, ctx.cwd, signal, onUpdate);
		},
		renderCall(args, theme) {
			const task = typeof args.task === "string" ? args.task : "";
			const preview = task.length > 80 ? `${task.slice(0, 80)}...` : task;
			return new Text(`${theme.fg("toolTitle", theme.bold("oracle"))} ${theme.fg("muted", preview)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = textFromResult(result);
			const details = normalizeOracleDetails(result.details, text);
			const params = context.args as OracleParams;
			if (expanded) {
				return new Text(renderOracleExpanded(params, details, text, isPartial, theme), 0, 0);
			}
			return new Text(renderOracleCollapsed(params, details, text, isPartial, theme), 0, 0);
		},
	});
}
