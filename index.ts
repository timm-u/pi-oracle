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
const ORACLE_TOOLS = process.env.PI_ORACLE_TOOLS || "read,grep,find,ls";
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

interface OracleToolUse {
	id: string;
	name: string;
	status: string;
	input?: unknown;
}

interface OracleDetails {
	model: string;
	thinking: string;
	cwd: string;
	files: string[];
	missingFiles: string[];
	progress: string[];
	currentMessage: string;
	currentReasoning: string;
	isThinking: boolean;
	activeTools: OracleToolUse[];
	usage: UsageStats;
	exitCode: number | null;
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

function pushProgress(details: OracleDetails, message: string) {
	const previous = details.progress.at(-1);
	if (previous !== message) details.progress.push(message);
	if (details.progress.length > 80) details.progress = details.progress.slice(-80);
}

function upsertToolUse(details: OracleDetails, tool: OracleToolUse) {
	const existingIndex = details.activeTools.findIndex((item) => item.id === tool.id);
	if (existingIndex >= 0) {
		const existing = details.activeTools[existingIndex];
		details.activeTools[existingIndex] = { ...existing, ...tool, input: tool.input ?? existing.input };
	} else {
		details.activeTools.push(tool);
	}
	if (details.activeTools.length > 20) details.activeTools = details.activeTools.slice(-20);
}

function buildOracleProgressBody(params: OracleParams, details: OracleDetails, finalText: string): string {
	const lines: string[] = [
		`Oracle is consulting ${details.model} (${details.thinking} thinking)`,
		`Task: ${truncateOneLine(params.task, 180)}`,
	];

	if (details.files.length > 0) {
		lines.push(`Files: ${details.files.map((file) => path.basename(file)).join(", ")}`);
	}
	if (details.missingFiles.length > 0) {
		lines.push(`Missing files: ${details.missingFiles.join(", ")}`);
	}

	const recentProgress = details.progress.slice(-10);
	if (recentProgress.length > 0) {
		lines.push("", "Progress:");
		for (const item of recentProgress) lines.push(`- ${item}`);
	}

	const visibleActiveTools = details.activeTools.filter((tool) => tool.status !== "done").slice(-8);
	if (visibleActiveTools.length > 0) {
		lines.push("", "Active tools:");
		for (const tool of visibleActiveTools) {
			lines.push(`- ${tool.status} ${formatToolInput(tool.name, tool.input)}`);
		}
	}

	if (details.currentReasoning.trim()) {
		lines.push("", details.isThinking ? "Reasoning now:" : "Recent reasoning:");
		lines.push(truncateText(details.currentReasoning, 1400));
	}

	const draft = finalText.trim() || details.currentMessage.trim();
	if (draft) {
		lines.push("", "Draft answer:");
		lines.push(truncateText(draft, 2200));
	}

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
		model: ORACLE_MODEL,
		thinking: ORACLE_THINKING,
		cwd,
		files: existingFiles,
		missingFiles,
		progress: [],
		currentMessage: "",
		currentReasoning: "",
		isThinking: false,
		activeTools: [],
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
			const body = buildOracleProgressBody(params, details, finalText);
			onUpdate?.(createPartialResult(body, details));
		};

		pushProgress(details, `started nested pi: ${ORACLE_MODEL} with ${ORACLE_THINKING} thinking`);
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
				pushProgress(details, "agent started");
				emitUpdate(true);
			} else if (event.type === "turn_start") {
				pushProgress(details, `turn ${details.usage.turns + 1} started`);
				details.currentMessage = "";
				details.currentReasoning = "";
				details.isThinking = true;
				emitUpdate(true);
			} else if (event.type === "tool_execution_start") {
				const id = String(event.toolCallId ?? `${event.toolName}-${details.progress.length}`);
				upsertToolUse(details, { id, name: event.toolName, status: "in-progress", input: event.args });
				pushProgress(details, `using ${formatToolInput(event.toolName, event.args)}`);
				emitUpdate(true);
			} else if (event.type === "tool_execution_update") {
				const id = String(event.toolCallId ?? `${event.toolName}-${details.progress.length}`);
				upsertToolUse(details, { id, name: event.toolName, status: "in-progress", input: event.args });
				emitUpdate();
			} else if (event.type === "tool_execution_end") {
				const id = String(event.toolCallId ?? `${event.toolName}-${details.progress.length}`);
				const status = event.isError ? "error" : "done";
				const existingTool = details.activeTools.find((tool) => tool.id === id);
				const input = event.args ?? existingTool?.input;
				upsertToolUse(details, { id, name: event.toolName, status, input });
				pushProgress(details, `${event.isError ? "failed" : "finished"} ${formatToolInput(event.toolName, input)}`);
				emitUpdate(true);
			} else if (event.type === "message_update") {
				const messageEvent = event.assistantMessageEvent;
				if (messageEvent?.type === "thinking_start") {
					details.currentReasoning = "";
					details.isThinking = true;
					pushProgress(details, "reasoning started");
					emitUpdate(true);
				} else if (messageEvent?.type === "thinking_delta") {
					details.currentReasoning += messageEvent.delta ?? "";
					details.isThinking = true;
					emitUpdate();
				} else if (messageEvent?.type === "thinking_end") {
					details.currentReasoning = messageEvent.content ?? details.currentReasoning;
					details.isThinking = false;
					pushProgress(details, "reasoning finished");
					emitUpdate(true);
				} else if (messageEvent?.type === "text_start") {
					pushProgress(details, "drafting answer");
					emitUpdate(true);
				} else if (messageEvent?.type === "text_delta") {
					finalText += messageEvent.delta ?? "";
					details.currentMessage = finalText;
					details.isThinking = false;
					emitUpdate();
				} else if (messageEvent?.type === "toolcall_start") {
					pushProgress(details, "preparing tool call");
					emitUpdate(true);
				} else if (messageEvent?.type === "toolcall_end") {
					const toolCall = messageEvent.toolCall;
					if (toolCall?.id && toolCall.name) {
						upsertToolUse(details, { id: toolCall.id, name: toolCall.name, status: "queued", input: toolCall.arguments });
						pushProgress(details, `queued ${formatToolInput(toolCall.name, toolCall.arguments)}`);
						emitUpdate(true);
					}
				}
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				const text = textFromMessage(event.message);
				if (text) finalText = text;
				details.currentMessage = finalText;
				details.isThinking = false;
				accumulateUsage(details.usage, event.message);
				emitUpdate(true);
			} else if (event.type === "turn_end") {
				details.usage.turns++;
				pushProgress(details, `turn ${details.usage.turns} finished`);
				details.isThinking = false;
				emitUpdate(true);
			} else if (event.type === "agent_end") {
				sawAgentEnd = true;
				const messages = Array.isArray(event.messages) ? event.messages : [];
				const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
				const text = textFromMessage(lastAssistant);
				if (text) finalText = text;
				details.currentMessage = finalText;
				details.isThinking = false;
				pushProgress(details, "agent finished");
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
				reject(new Error(stderr.trim() || `Oracle process exited with code ${code}`));
				return;
			}

			if (!sawAgentEnd && !finalText) {
				reject(new Error(stderr.trim() || "Oracle process ended without a final answer"));
				return;
			}

			resolve(createPartialResult(finalText.trim() || "(Oracle returned no text.)", details));
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
		renderResult(result, { expanded }, theme) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "";
			if (expanded) return new Text(text, 0, 0);

			const firstLine = text
				.split("\n")
				.map((line) => line.trim())
				.find(Boolean);
			const summary = firstLine && firstLine.length > 160 ? `${firstLine.slice(0, 160)}...` : firstLine;
			const details = result.details as OracleDetails | undefined;
			const usage = details?.usage;
			const suffix = usage?.cost ? theme.fg("dim", ` ($${usage.cost.toFixed(4)})`) : "";
			const textWithUsage = text.trim()
				? `${text.trim()}${suffix ? `\n\n${suffix}` : ""}`
				: theme.fg("success", "Oracle answered") + suffix;

			if (expanded && details?.progress?.length) {
				return new Text(`${textWithUsage}\n\n${theme.fg("dim", "Oracle progress:")}\n${details.progress.map((line) => theme.fg("dim", `- ${line}`)).join("\n")}`, 0, 0);
			}

			return new Text(textWithUsage || summary || "Oracle answered", 0, 0);
		},
	});
}
