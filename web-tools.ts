import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const USER_AGENT =
	"Mozilla/5.0 (compatible; pi-oracle-extension/1.0; +https://github.com/badlogic/pi-mono)";
const MAX_PAGE_CHARS = 60_000;
const MAX_SEARCH_RESULTS = 8;
const MAX_THREAD_CHARS = 80_000;
const MAX_THREAD_RESULTS = 12;
const MAX_CODEX_SEARCH_CHARS = 60_000;
const CODEX_SEARCH_TIMEOUT_MS = Number(process.env.PI_ORACLE_CODEX_SEARCH_TIMEOUT_MS ?? 120_000);
const CODEX_SEARCH_MODEL = process.env.PI_ORACLE_CODEX_SEARCH_MODEL ?? "gpt-5.4-mini";
const WEB_BACKEND = (process.env.PI_ORACLE_WEB_BACKEND ?? "auto").toLowerCase();

type SearchResult = { title: string; url: string; snippet: string };
type WebSearchDetails =
	| { backend: "duckduckgo"; query: string; results: SearchResult[]; fallbackFrom?: "codex"; codexError?: string }
	| {
			backend: "codex";
			query: string;
			model: string;
			searches: Array<{ query?: string; queries?: string[] }>;
			usage?: unknown;
	  };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function decodeHtml(input: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};
	return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
		if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
		if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
		return named[entity] ?? match;
	});
}

function stripTags(html: string): string {
	return decodeHtml(
		html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
			.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/[ \t\f\v]+/g, " ")
			.replace(/\n\s+/g, "\n")
			.replace(/\n{3,}/g, "\n\n"),
	).trim();
}

function absolutizeUrl(href: string, base: string): string {
	try {
		const url = new URL(decodeHtml(href), base);
		const redirected = url.searchParams.get("uddg");
		if (redirected) return redirected;
		return url.toString();
	} catch {
		return decodeHtml(href);
	}
}

async function fetchText(url: string, signal?: AbortSignal): Promise<{ text: string; contentType: string }> {
	const response = await fetch(url, {
		signal,
		headers: {
			"User-Agent": USER_AGENT,
			Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
		},
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}
	const contentType = response.headers.get("content-type") ?? "";
	const text = await response.text();
	return { text, contentType };
}

function parseDuckDuckGo(html: string): SearchResult[] {
	const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"[^>]*>/i).slice(1);
	const results: SearchResult[] = [];

	for (const block of blocks) {
		const link = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
		if (!link) continue;
		const snippet = block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
			?? block.match(/<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

		const title = stripTags(link[2] ?? "");
		const url = absolutizeUrl(link[1] ?? "", "https://html.duckduckgo.com/");
		const snippetText = snippet ? stripTags(snippet[1] ?? "") : "";
		if (title && url) results.push({ title, url, snippet: snippetText });
	}

	return results;
}

function renderSearchResults(results: SearchResult[]): string {
	return results
		.map((result, index) => {
			const snippet = result.snippet ? `\n   ${result.snippet}` : "";
			return `${index + 1}. ${result.title}\n   ${result.url}${snippet}`;
		})
		.join("\n\n");
}

async function duckDuckGoSearch(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<{ output: string; details: { backend: "duckduckgo"; query: string; results: SearchResult[] } }> {
	const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const { text } = await fetchText(searchUrl, signal);
	const results = parseDuckDuckGo(text).slice(0, maxResults);
	return {
		output: results.length > 0 ? renderSearchResults(results) : "No search results parsed.",
		details: { backend: "duckduckgo", query, results },
	};
}

function buildCodexSearchPrompt(query: string, maxResults: number): string {
	return [
		"Use live web search only. Do not inspect or modify local files.",
		`Search query: ${query}`,
		`Return the ${maxResults} most useful results for an AI coding agent.`,
		"Prefer primary sources, official docs, repository pages, changelogs, specs, and issue/PR discussions when relevant.",
		"Final answer format:",
		"1. Title",
		"   URL",
		"   One concise snippet explaining why this result matters.",
		"Include direct URLs. Keep it compact. Do not include unrelated commentary.",
	].join("\n");
}

function getCodexInvocation(): { command: string; argsPrefix: string[] } {
	if (process.platform !== "win32") return { command: "codex", argsPrefix: [] };

	const explicit = process.env.PI_ORACLE_CODEX_JS;
	const candidates = [
		explicit,
		process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js") : undefined,
		process.env.npm_config_prefix
			? path.join(process.env.npm_config_prefix, "node_modules", "@openai", "codex", "bin", "codex.js")
			: undefined,
	].filter((candidate): candidate is string => Boolean(candidate));

	const codexJs = candidates.find((candidate) => fs.existsSync(candidate));
	if (codexJs) return { command: process.execPath, argsPrefix: [codexJs] };

	return { command: "codex", argsPrefix: [] };
}

async function codexWebSearch(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<{
	output: string;
	details: {
		backend: "codex";
		query: string;
		model: string;
		searches: Array<{ query?: string; queries?: string[] }>;
		usage?: unknown;
	};
}> {
	const runSignal = signal ?? new AbortController().signal;
	const invocation = getCodexInvocation();
	const args = [
		...invocation.argsPrefix,
		"--search",
		"exec",
		"--skip-git-repo-check",
		"--ephemeral",
		"--sandbox",
		"read-only",
		"--model",
		CODEX_SEARCH_MODEL,
		"--json",
		"--color",
		"never",
		buildCodexSearchPrompt(query, maxResults),
	];

	const child = spawn(invocation.command, args, {
		cwd: process.cwd(),
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	const agentMessages: string[] = [];
	const searches: Array<{ query?: string; queries?: string[] }> = [];
	let usage: unknown;

	const kill = () => {
		if (!child.killed) child.kill();
	};
	const timeout = Number.isFinite(CODEX_SEARCH_TIMEOUT_MS) && CODEX_SEARCH_TIMEOUT_MS > 0
		? setTimeout(kill, CODEX_SEARCH_TIMEOUT_MS)
		: undefined;
	const abort = () => kill();
	runSignal.addEventListener("abort", abort, { once: true });

	child.stdin.end();
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		for (const line of String(chunk).split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);
				if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
					agentMessages.push(String(event.item.text));
				}
				if (event.type === "item.completed" && event.item?.type === "web_search") {
					searches.push({
						query: event.item.action?.query ?? event.item.query,
						queries: event.item.action?.queries,
					});
				}
				if (event.type === "turn.completed" && event.usage) usage = event.usage;
			} catch {
				// Codex may print non-JSON progress on stderr/stdout in some builds.
			}
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});

	if (timeout) clearTimeout(timeout);
	runSignal.removeEventListener("abort", abort);
	if (runSignal.aborted) throw new Error("Codex web search aborted");
	if (exitCode !== 0) {
		const message = stderr.trim() || stdout.trim() || `codex exited with code ${exitCode}`;
		throw new Error(message.slice(0, 2_000));
	}

	const finalMessage = agentMessages.at(-1)?.trim() || stdout.trim();
	const output = finalMessage.length > MAX_CODEX_SEARCH_CHARS
		? `${finalMessage.slice(0, MAX_CODEX_SEARCH_CHARS)}\n\n[truncated after ${MAX_CODEX_SEARCH_CHARS} characters]`
		: finalMessage;
	if (!output) throw new Error("Codex web search returned no final message");

	return {
		output,
		details: {
			backend: "codex",
			query,
			model: CODEX_SEARCH_MODEL,
			searches,
			usage,
		},
	};
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function getSessionDir(): string {
	return path.join(getAgentDir(), "sessions");
}

function listSessionFiles(dir = getSessionDir()): string[] {
	if (!fs.existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listSessionFiles(fullPath));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
	}
	return files.sort((a, b) => {
		try {
			return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
		} catch {
			return 0;
		}
	});
}

function messageText(message: any): string {
	if (!message?.content) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part: any) => {
			if (part?.type === "text") return part.text ?? "";
			if (part?.type === "toolCall") return `[tool call: ${part.name ?? "tool"} ${JSON.stringify(part.arguments ?? {})}]`;
			if (part?.type === "thinking") return "[thinking omitted]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function summarizeSession(filePath: string, query?: string): { id: string; path: string; cwd?: string; timestamp?: string; preview: string; score: number } {
	const text = fs.readFileSync(filePath, "utf-8");
	const lines = text.split(/\r?\n/).filter(Boolean);
	let cwd: string | undefined;
	let timestamp: string | undefined;
	const previews: string[] = [];
	let score = 0;
	const needle = query?.toLowerCase();

	for (const line of lines) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === "session") {
			cwd = entry.cwd;
			timestamp = entry.timestamp;
		}

		const message = entry.message ?? (entry.role ? entry : undefined);
		if (!message) continue;
		const textPart = messageText(message).trim();
		if (!textPart) continue;
		if (previews.length < 4 && (message.role === "user" || message.role === "assistant")) {
			previews.push(`${message.role}: ${textPart.replace(/\s+/g, " ").slice(0, 220)}`);
		}
		if (needle && (textPart.toLowerCase().includes(needle) || filePath.toLowerCase().includes(needle))) {
			score++;
		}
	}

	return {
		id: path.basename(filePath, ".jsonl"),
		path: filePath,
		cwd,
		timestamp,
		preview: previews.join("\n"),
		score,
	};
}

function findSessionFile(thread: string): string | undefined {
	const normalized = thread.trim();
	if (!normalized) return undefined;
	if (fs.existsSync(normalized)) return normalized;
	const withoutAt = normalized.startsWith("@") ? normalized.slice(1) : normalized;
	if (fs.existsSync(withoutAt)) return withoutAt;

	const files = listSessionFiles();
	return files.find((file) => {
		const id = path.basename(file, ".jsonl");
		return id === withoutAt || id.includes(withoutAt) || file.includes(withoutAt);
	});
}

function renderThread(filePath: string): string {
	const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
	const rendered: string[] = [`# Thread ${path.basename(filePath, ".jsonl")}`, `Path: ${filePath}`];

	for (const line of lines) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === "session") {
			rendered.push(`\nSession: ${entry.timestamp ?? ""}`);
			if (entry.cwd) rendered.push(`CWD: ${entry.cwd}`);
			continue;
		}

		const message = entry.message ?? (entry.role ? entry : undefined);
		if (!message) continue;
		const text = messageText(message).trim();
		if (!text) continue;
		const label = message.role === "toolResult" ? `tool:${message.toolName ?? "tool"}` : message.role;
		rendered.push(`\n## ${label}\n${text}`);
	}

	const output = rendered.join("\n");
	return output.length > MAX_THREAD_CHARS
		? `${output.slice(0, MAX_THREAD_CHARS)}\n\n[truncated after ${MAX_THREAD_CHARS} characters]`
		: output;
}

export default function webTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_web_page",
		label: "read web page",
		description: "Read a web page by URL and return extracted text. Use when current external documentation or references are needed.",
		promptSnippet: "read_web_page - Read and extract text from a URL.",
		parameters: Type.Object({
			url: Type.String({ description: "The absolute URL to read." }),
		}),
		async execute(_toolCallId, params, signal) {
			const url = String((params as { url: string }).url ?? "").trim();
			if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");

			const { text, contentType } = await fetchText(url, signal);
			const readable = contentType.includes("html") ? stripTags(text) : text.trim();
			const truncated = readable.length > MAX_PAGE_CHARS;
			const output = truncated
				? `${readable.slice(0, MAX_PAGE_CHARS)}\n\n[truncated after ${MAX_PAGE_CHARS} characters]`
				: readable;
			return {
				content: [{ type: "text", text: output }],
				details: { url, contentType, truncated },
			};
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "web search",
		description: "Search the web and return a short list of result titles, URLs, and snippets.",
		promptSnippet: "web_search - Search the web for current external references.",
		parameters: Type.Object({
			query: Type.String({ description: "The web search query." }),
			max_results: Type.Optional(
				Type.Number({
					description: `Maximum results to return. Default ${MAX_SEARCH_RESULTS}.`,
					minimum: 1,
					maximum: MAX_SEARCH_RESULTS,
				}),
			),
		}),
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<WebSearchDetails>> {
			const query = String((params as { query: string }).query ?? "").trim();
			const requestedMax = Number((params as { max_results?: number }).max_results ?? MAX_SEARCH_RESULTS);
			const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number.isFinite(requestedMax) ? requestedMax : MAX_SEARCH_RESULTS));
			if (!query) throw new Error("query is required");

			if (WEB_BACKEND === "duckduckgo") {
				const result = await duckDuckGoSearch(query, maxResults, signal);
				return {
					content: [{ type: "text", text: result.output }],
					details: result.details,
				};
			}

			try {
				const result = await codexWebSearch(query, maxResults, signal);
				return {
					content: [{ type: "text", text: result.output }],
					details: result.details,
				};
			} catch (error) {
				if (WEB_BACKEND === "codex") throw error;
				const fallback = await duckDuckGoSearch(query, maxResults, signal);
				const output = [
					`Codex web search failed, so this used the DuckDuckGo HTML fallback. Error: ${errorMessage(error)}`,
					"",
					fallback.output,
				].join("\n");
				return {
					content: [{ type: "text", text: output }],
					details: { ...fallback.details, fallbackFrom: "codex", codexError: errorMessage(error) },
				};
			}
		},
	});

	pi.registerTool({
		name: "find_thread",
		label: "find thread",
		description:
			"Find local Pi conversation threads by keyword or file path. This approximates Amp's find_thread for Pi session history.",
		promptSnippet: "find_thread - Search local Pi session history.",
		parameters: Type.Object({
			query: Type.String({ description: "Keyword, file path, task, or partial session id to search for." }),
			max_results: Type.Optional(
				Type.Number({
					description: `Maximum results to return. Default ${MAX_THREAD_RESULTS}.`,
					minimum: 1,
					maximum: MAX_THREAD_RESULTS,
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const query = String((params as { query: string }).query ?? "").trim();
			const requestedMax = Number((params as { max_results?: number }).max_results ?? MAX_THREAD_RESULTS);
			const maxResults = Math.max(1, Math.min(MAX_THREAD_RESULTS, Number.isFinite(requestedMax) ? requestedMax : MAX_THREAD_RESULTS));
			if (!query) throw new Error("query is required");

			const summaries = listSessionFiles()
				.map((file) => summarizeSession(file, query))
				.filter((summary) => summary.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, maxResults);

			const output =
				summaries.length > 0
					? summaries
							.map((summary, index) => {
								return [
									`${index + 1}. ${summary.id}`,
									`   path: ${summary.path}`,
									summary.cwd ? `   cwd: ${summary.cwd}` : undefined,
									summary.timestamp ? `   timestamp: ${summary.timestamp}` : undefined,
									summary.preview ? `   preview:\n${summary.preview}` : undefined,
								]
									.filter(Boolean)
									.join("\n");
							})
							.join("\n\n")
					: "No matching Pi sessions found.";

			return {
				content: [{ type: "text", text: output }],
				details: { query, results: summaries },
			};
		},
	});

	pi.registerTool({
		name: "read_thread",
		label: "read thread",
		description:
			"Read a local Pi conversation thread by full path, filename, or partial session id. This approximates Amp's read_thread for Pi session history.",
		promptSnippet: "read_thread - Read a local Pi session by id or path.",
		parameters: Type.Object({
			thread: Type.String({ description: "Thread/session path, filename, or partial session id." }),
		}),
		async execute(_toolCallId, params) {
			const thread = String((params as { thread: string }).thread ?? "").trim();
			const filePath = findSessionFile(thread);
			if (!filePath) throw new Error(`No Pi session found for "${thread}"`);
			return {
				content: [{ type: "text", text: renderThread(filePath) }],
				details: { thread, path: filePath },
			};
		},
	});
}
