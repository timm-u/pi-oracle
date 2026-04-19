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

interface OracleDetails {
	model: string;
	thinking: string;
	cwd: string;
	files: string[];
	missingFiles: string[];
	progress: string[];
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

		const emitUpdate = () => {
			const progress = details.progress.slice(-6).join("\n");
			const body = finalText
				? `Oracle is working...\n\n${finalText.slice(-3000)}`
				: `Oracle is working...\n${progress ? `\n${progress}` : ""}`;
			onUpdate?.(createPartialResult(body, details));
		};

		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "tool_execution_start") {
				const argsText = JSON.stringify(event.args ?? {});
				details.progress.push(`started ${event.toolName} ${argsText.length > 160 ? `${argsText.slice(0, 160)}...` : argsText}`);
				emitUpdate();
			} else if (event.type === "tool_execution_end") {
				details.progress.push(`${event.isError ? "failed" : "finished"} ${event.toolName}`);
				emitUpdate();
			} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				finalText += event.assistantMessageEvent.delta ?? "";
				emitUpdate();
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				const text = textFromMessage(event.message);
				if (text) finalText = text;
				accumulateUsage(details.usage, event.message);
			} else if (event.type === "turn_end") {
				details.usage.turns++;
			} else if (event.type === "agent_end") {
				sawAgentEnd = true;
				const messages = Array.isArray(event.messages) ? event.messages : [];
				const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
				const text = textFromMessage(lastAssistant);
				if (text) finalText = text;
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
			return new Text(theme.fg("success", summary || "Oracle answered") + suffix, 0, 0);
		},
	});
}
