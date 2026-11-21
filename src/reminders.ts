import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, type MessageRenderer, Text, z } from "@oh-my-pi/pi-coding-agent";
import { buildNamedToolChoice } from "@oh-my-pi/pi-coding-agent/utils/tool-choice";
import { type NativeNode, node, span } from "@oh-my-pi/pi-tui";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { tr } from "../omomp-shared/i18n.ts";
import { type BranchFacts, branchFacts, contextBranch } from "./branch.ts";
import { errorText } from "./errors.ts";
import { type CutOffWait, cutOffWait, quotaDeadline, quotaNoticeLine } from "./quota-wait.ts";
import { sessionOf } from "./session.ts";
import { DEFAULT_SETTINGS, readSettings, silenceNativeTodoAutomation, type TodoMoreSettings } from "./settings.ts";
import {
	actionableItems,
	explanationText,
	goalLines,
	REMINDER_TYPE,
	TODO_MORE_ENTRY_TYPE,
	type TodoItem,
	type TodoMoreState,
	timeEstimateText,
	unexplainedItems,
} from "./state.ts";
import { isT3Host } from "./t3-parent.ts";

const MID_RUN_NUDGE_TYPE = `${TODO_MORE_ENTRY_TYPE}.mid-run-nudge`;
const EAGER_PRELUDE_TYPE = `${TODO_MORE_ENTRY_TYPE}.eager-prelude`;
const GOAL_MODE_CONTEXT_TYPE = "goal-mode-context";
const TODO_TOOL = "todo";
const CUT_OFF_GRACE_MS = 10_000;
const MAX_TIMER_SEGMENT_MS = 60 * 60_000;
const DRAFT_RECHECK_MS = 10_000;
const QUOTA_NOTICE_WIDGET_KEY = "todo-more.quota-reminder";
const CANCEL_SHORTCUT = "ctrl+n";
const CANCEL_SHORTCUT_LABEL = "Ctrl+N";
const CANCEL_COMMAND = "todo-more-cancel";

const MID_RUN_NUDGE_MUTATION_THRESHOLD = 12;
const MID_RUN_NUDGE_MAX_PER_CYCLE = 2;
const MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
	ast_edit: true,
};

const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const INLINE_EMPHASIS_RE = /(\*\*|__)(.*?)\1/g;
const OPTION_LINE_RE = /^(?:[-*+]|\d+[.)])\s+\S/;
const RECOMMENDATION_RE = /^(?:i(?:'d| would)?\s+recommend|(?:my\s+)?recommendation)\b/i;
const CHOICE_CONFIRMATION_RE = /^(?:go|proceed|continue|stick)\s+with\b/i;
const QUESTION_PROMPT_RE =
	/^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const USER_RESPONSE_CUE_RE =
	/^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: upstream's ASCII range test.
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;

// Strikethrough is deliberately absent: `~~…~~` marks the
// author as having discarded the span, so unwrapping it would promote a retracted
// question back to a live one and idle the session waiting for an answer nobody is going to give.
const WRAPPED_EMPHASIS_RE = /^(\*\*\*|\*\*|\*|___|__|_)([\s\S]+)\1$/;

interface PromptLine {
	text: string;
	hadPromptLabel: boolean;
}

type ListState = Extract<TodoMoreState, { kind: "list" }>;
type OpenItem = { readonly phase: string; readonly item: TodoItem };

const reminderDetailsSchema = z.object({
	items: z.array(z.object({ phase: z.string(), title: z.string() })),
	attempt: z.number(),
	max: z.number(),
});
type ReminderDetails = z.infer<typeof reminderDetailsSchema>;

type Cycle = {
	reminderCount: number;
	awaitingProgress: boolean;
	mutationsSinceLastTouch: number;
	midRunNudgeCount: number;
};

type PendingContinuation =
	| { readonly kind: "none" }
	| { readonly kind: "main"; readonly text: string; readonly details: ReminderDetails; readonly countBefore: number }
	| { readonly kind: "sub"; readonly text: string };

const NO_PENDING: PendingContinuation = { kind: "none" };

type Completion =
	| { readonly kind: "silent" }
	| { readonly kind: "reset" }
	| { readonly kind: "remind"; readonly attempt: number; readonly text: string; readonly details: ReminderDetails };

const SILENT: Completion = { kind: "silent" };
const RESET: Completion = { kind: "reset" };

type CutOffLatch = { readonly kind: "open" } | { readonly kind: "nudged"; readonly text: string } | { readonly kind: "cancelled" };

const LATCH_OPEN: CutOffLatch = { kind: "open" };
const LATCH_CANCELLED: CutOffLatch = { kind: "cancelled" };

type CutOffPlan = {
	readonly ctx: ExtensionContext;
	readonly session: AgentSession;
	readonly message: AssistantMessage;
	readonly wait: CutOffWait;
};
type PendingCutOff = CutOffPlan & { readonly timer: Timer };

type CutOffStep =
	| { readonly kind: "wait"; readonly ms: number }
	| { readonly kind: "drop" }
	| { readonly kind: "remind"; readonly completion: Extract<Completion, { kind: "remind" }> };

const DROP: CutOffStep = { kind: "drop" };

const ownSession = (ctx: ExtensionContext): AgentSession | undefined => sessionOf(ctx.agent.id);

const facts = (ctx: ExtensionContext): BranchFacts => branchFacts(contextBranch(ctx));

function resetCycle(cycle: Cycle): void {
	cycle.awaitingProgress = false;
	cycle.mutationsSinceLastTouch = 0;
	cycle.midRunNudgeCount = 0;
}

function onToolResult(cycle: Cycle, toolName: string, isError: boolean): void {
	if (toolName === TODO_TOOL) {
		cycle.mutationsSinceLastTouch = 0;
	} else if (!isError && MUTATING_TOOLS[toolName]) {
		cycle.mutationsSinceLastTouch++;
	}
	cycle.awaitingProgress = false;
}

function todoToolRef(session: AgentSession): string {
	const tool = session.getToolByName(TODO_TOOL);
	return typeof tool?.customWireName === "string" ? tool.customWireName : TODO_TOOL;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

function promptLine(line: string): PromptLine {
	const withoutMarkdownPrefix = line.trim().replace(INLINE_EMPHASIS_RE, "$2").replace(MARKDOWN_PROMPT_PREFIX_RE, "").trim();
	const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, "").trim();
	const withoutEmphasis = withoutPromptLabel.replace(WRAPPED_EMPHASIS_RE, "$2").trim();
	return {
		text: withoutEmphasis,
		hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
	};
}

function isQuestionPromptLine(line: string): boolean {
	const candidate = promptLine(line);
	if (!/[?？]\s*$/.test(candidate.text)) return false;
	return (
		candidate.hadPromptLabel ||
		QUESTION_PROMPT_RE.test(candidate.text) ||
		CHOICE_CONFIRMATION_RE.test(candidate.text) ||
		USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
		NON_ASCII_TEXT_RE.test(candidate.text)
	);
}

function isResponseCueLine(line: string): boolean {
	const candidate = promptLine(line)
		.text.replace(/[.!?。！？]+$/, "")
		.trim();
	return USER_RESPONSE_CUE_RE.test(candidate);
}

function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	const text = assistantText(message);
	if (!text) return false;
	const lines = text.split(/\r?\n/);
	const lastLine = lines.at(-1)?.trim();
	if (lastLine !== undefined && (isQuestionPromptLine(lastLine) || isResponseCueLine(lastLine))) return true;

	let optionCount = 0;
	let hasRecommendation = false;
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]?.trim();
		if (!line) continue;
		if (OPTION_LINE_RE.test(line)) {
			optionCount++;
			continue;
		}
		const candidate = promptLine(line);
		if (optionCount > 0) {
			return (
				optionCount >= 2 &&
				isQuestionPromptLine(line) &&
				(hasRecommendation ||
					candidate.hadPromptLabel ||
					USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
					CHOICE_CONFIRMATION_RE.test(candidate.text))
			);
		}
		if (RECOMMENDATION_RE.test(candidate.text)) {
			hasRecommendation = true;
			continue;
		}
		return false;
	}
	return false;
}

function goalBlock(state: ListState): string[] {
	switch (state.goal.kind) {
		case "set":
			return ["Goal:", ...goalLines(state.goal.goal).map((line) => `  ${line}`)];
		case "missing":
			return ["Goal: none yet — put GOAL first in the next Todo document."];
		default: {
			const unreachable: never = state.goal;
			throw new Error(`Unexpected goal state: ${String(unreachable)}`);
		}
	}
}

function unexplainedLines(state: ListState): string[] {
	const unexplained = unexplainedItems(state);
	if (unexplained.length === 0) return [];
	return [
		`Items without an explanation (${unexplained.length}); batch EXPLAIN commands: ${unexplained.map((item) => JSON.stringify(item.title)).join(", ")}`,
	];
}

function byPhase(open: readonly OpenItem[]): { readonly name: string; readonly items: TodoItem[] }[] {
	const groups: { name: string; items: TodoItem[] }[] = [];
	for (const { phase, item } of open) {
		const last = groups.at(-1);
		if (last !== undefined && last.name === phase) last.items.push(item);
		else groups.push({ name: phase, items: [item] });
	}
	return groups;
}

function reminderText(state: ListState, open: readonly OpenItem[], attempt: number, max: number): string {
	const todoList = byPhase(open)
		.map(
			(phase) =>
				`- ${phase.name}\n${phase.items.map((item) => `  - ${item.title}\n    ${explanationText(item).replaceAll("\n", "\n    ")}\n    ${timeEstimateText(item.time)}`).join("\n")}`,
		)
		.join("\n");
	return (
		`<system-reminder>\n` +
		`You stopped with ${open.length} incomplete todo item(s):\n${todoList}\n\n` +
		`${[...goalBlock(state), ...unexplainedLines(state)].join("\n")}\n\n` +
		`Please continue working on these tasks or mark them complete if finished.\n` +
		`(Reminder ${attempt}/${max})\n` +
		`</system-reminder>`
	);
}

/**
 * Native's reset when `todo` is not an active tool is left out: in a subagent the
 * host drops `todo` from every active-set write and todo-more adds it back before
 * each model call, so that guard would reset subagent reminders.
 */
function checkCompletion(
	session: AgentSession,
	settings: TodoMoreSettings,
	cycle: Cycle,
	count: number,
	message: AssistantMessage,
	state: TodoMoreState,
): Completion {
	if (session.getPlanModeState()?.enabled === true) return SILENT;
	if (cycle.awaitingProgress) return SILENT;
	if (!settings.reminders) return RESET;
	const max = settings.remindersMax;
	if (count >= max) return SILENT;
	if (state.kind === "empty") return RESET;
	const open = actionableItems(state);
	if (open.length === 0) return RESET;
	if (isAwaitingUserAnswer(message)) return SILENT;
	if (session.wakeSources !== undefined) return SILENT;
	const attempt = count + 1;
	return {
		kind: "remind",
		attempt,
		text: reminderText(state, open, attempt, max),
		details: { items: open.map(({ phase, item }) => ({ phase, title: item.title })), attempt, max },
	};
}

function terminalAnswer(message: AgentMessage | undefined): AssistantMessage | undefined {
	if (message?.role !== "assistant") return undefined;
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	if (message.content.some((content) => content.type === "toolCall")) return undefined;
	return assistantText(message) === "" ? undefined : message;
}

const CUT_OFF_STOP_REASONS: Record<string, true> = { error: true, toolUse: true };

const USER_INTERRUPT_LABEL = "Interrupted by user";
const SILENT_ABORT_MARKER = "__omp.silent_abort__";
const HUMAN_ABORT_FLAGS = 0x0400_0000 | 0x0200_0000;

function isHumanAbort(message: AssistantMessage): boolean {
	const errorId = message.errorId;
	return (
		(typeof errorId === "number" && (errorId & HUMAN_ABORT_FLAGS) !== 0) ||
		message.errorMessage === USER_INTERRUPT_LABEL ||
		message.errorMessage === SILENT_ABORT_MARKER
	);
}

function cutOffAnswer(message: AgentMessage | undefined): AssistantMessage | undefined {
	if (message?.role !== "assistant") return undefined;
	if (message.stopReason === "aborted") return isHumanAbort(message) ? undefined : message;
	return CUT_OFF_STOP_REASONS[message.stopReason] === true ? message : undefined;
}

function eagerTodoText(todo: string, forced: boolean): string {
	const body = forced
		? `Before substantive work, create a phased todo.

You MUST call \`${todo}\` first in this turn.
You MUST initialize the entire todo list in one complete document with INIT "objective" "measure" "doneWhen": what this work is, how its result is measured, how far it must go to count as done.
You MUST cover the entire request from investigation through implementation and verification — not just the immediate next step.
Use PHASE "name" and ADD "title" "explanation" minutes lines. Each title MUST be a concise, specific 5-10 word label; each explanation says what the item covers and what shows it is finished. Estimate every item yourself in positive integer minutes; no fractions or defaults.
Wrap all commands in *** Begin Todo and *** End Todo, JSON-quote strings, and do not invent fields or call separately per item. Partial input is not saved.

After \`${todo}\` succeeds, continue the request in the same turn.
NEVER call \`${todo}\` again unless task state has materially changed.`
		: `If this request is multi-step work (several dependent changes, or work spanning more than one turn), call \`${todo}\` first to lay out a phased plan in one complete Todo document; a single quick change, a command the user asked to run, discussion, investigation, explanation and questions need no todo. Cover the whole request — investigation through implementation and verification — not just the next step.
Use INIT "objective" "measure" "doneWhen", PHASE "name", and ADD "title" "explanation" minutes between *** Begin Todo and *** End Todo. Use JSON-quoted strings, specific titles, complete explanations and your own positive integer minute estimates; no fractions or defaults.
If you create the list, continue the request in the same turn and avoid re-calling \`${todo}\` unless task state materially changes.`;
	return `<system-reminder>\n${body}\n</system-reminder>\n`;
}

function eagerTodoPrelude(
	pi: ExtensionAPI,
	session: AgentSession,
	settings: TodoMoreSettings,
	state: TodoMoreState,
	promptText: string | undefined,
): { customType: string; content: string; display: false; attribution: "agent" } | undefined {
	const mode = settings.eager;
	if (mode === "default") return undefined;
	if (session.getPlanModeState()?.enabled === true || state.kind !== "empty") return undefined;
	if (session.getPrewalkState() !== undefined) return undefined;
	if (promptText !== undefined) {
		if (session.toolChoiceQueue.inspect().includes("user-force")) return undefined;
		if (session.agent.state.messages.some((message) => message.role === "user")) return undefined;
		const trimmedPromptText = promptText.trimEnd();
		if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) return undefined;
	}
	const activeToolNames = session.getActiveToolNames();
	if (!activeToolNames.includes(TODO_TOOL)) {
		pi.logger.warn("Eager todo enforcement skipped because todo is not active", { activeToolNames });
		return undefined;
	}
	const message = {
		customType: EAGER_PRELUDE_TYPE,
		content: eagerTodoText(todoToolRef(session), mode === "always"),
		display: false as const,
		attribution: "agent" as const,
	};
	if (promptText === undefined || mode === "preferred") return message;
	const model = session.model;
	const toolChoice = buildNamedToolChoice(TODO_TOOL, model);
	if (!toolChoice) {
		pi.logger.warn("Eager todo proceeding with the reminder only because the current model does not support a forced todo tool_choice", {
			modelApi: model?.api,
			modelId: model?.id,
		});
		return message;
	}
	session.toolChoiceQueue.pushOnce(toolChoice, { label: "eager-todo" });
	return message;
}

function takeMidRunNudge(
	session: AgentSession,
	settings: TodoMoreSettings,
	cycle: Cycle,
	state: TodoMoreState,
): { customType: string; content: string; display: false; attribution: "agent" } | undefined {
	if (cycle.mutationsSinceLastTouch < MID_RUN_NUDGE_MUTATION_THRESHOLD) return undefined;
	if (cycle.midRunNudgeCount >= MID_RUN_NUDGE_MAX_PER_CYCLE) return undefined;
	if (!settings.reminders) return undefined;
	if (session.getPlanModeState()?.enabled === true || !session.getActiveToolNames().includes(TODO_TOOL)) return undefined;
	if (state.kind === "empty") return undefined;
	const incomplete = actionableItems(state);
	if (incomplete.length === 0) return undefined;
	cycle.mutationsSinceLastTouch = 0;
	cycle.midRunNudgeCount++;
	return {
		customType: MID_RUN_NUDGE_TYPE,
		content: midRunNudgeText(todoToolRef(session), incomplete.length, state),
		display: false,
		attribution: "agent",
	};
}

function midRunNudgeText(todo: string, incompleteCount: number, state: ListState): string {
	const goal =
		state.goal.kind === "set"
			? `Goal objective: ${state.goal.goal.objective}`
			: `The list has no goal yet: put GOAL first in the next \`${todo}\` document.`;
	return `<system-reminder>
${incompleteCount} todo item${incompleteCount !== 1 ? "s" : ""} still open. If you finished a task since last \`${todo}\` update, mark it done now so progress stays visible; otherwise keep working.
${goal}
</system-reminder>
`;
}

function sanitizeGoalTodoText(text: string): string {
	return (
		escapeXmlText(text)
			.replace(/\r\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: upstream flattens control characters.
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
	);
}

function goalTodoContext(session: AgentSession, state: TodoMoreState): string | undefined {
	const canCallTodoTool = session.getActiveToolNames().includes(TODO_TOOL);
	if (!canCallTodoTool) return undefined;
	if (state.kind === "empty") return undefined;
	const phases = state.phases.filter((phase) => phase.items.length > 0);
	if (phases.length === 0) return undefined;

	let total = 0;
	let closed = 0;
	let open = 0;
	const phaseLines = phases.flatMap((phase) => [
		`- ${sanitizeGoalTodoText(phase.name)}`,
		...phase.items.map((item) => {
			total++;
			if (item.status === "completed" || item.status === "abandoned") {
				closed++;
			} else {
				open++;
			}
			return `  - [${item.status}] ${sanitizeGoalTodoText(item.title)}: ${sanitizeGoalTodoText(explanationText(item))}; ${sanitizeGoalTodoText(timeEstimateText(item.time))}`;
		}),
	]);
	const goal =
		state.goal.kind === "set"
			? goalLines(state.goal.goal).map((line) => sanitizeGoalTodoText(line))
			: [`Goal: none yet — put GOAL first in the next \`${todoToolRef(session)}\` document.`];

	return `<todo_context>
Persisted todos: live progress state for current goal, not old transcript decoration; goal continuations lack visible user nudge → treat as live state.
Before substantial work: compare next action with todos. If item stale, already finished, or no longer active pointer, call \`${todoToolRef(session)}\` first: mark done or rewrite list. Do not leave stale in_progress while working on later phases.

Todo list goal:
${goal.join("\n")}

Overall: ${closed}/${total} done, ${open} open.
${phaseLines.join("\n")}
</todo_context>
`;
}

function withAppendedText(message: AgentMessage, text: string): AgentMessage {
	if (message.role !== "custom") return message;
	const content =
		typeof message.content === "string" ? `${message.content}\n${text}` : [...message.content, { type: "text" as const, text }];
	return { ...message, content };
}

const NATIVE_GOAL_TODO_CONTEXT = "\n<todo_context>\nPersisted todos:";

function withoutNativeTodoText(text: string): string {
	const index = text.indexOf(NATIVE_GOAL_TODO_CONTEXT, Math.max(0, text.lastIndexOf("</goal_context>")));
	return index < 0 ? text : text.slice(0, index);
}

function withoutNativeTodoContext(message: AgentMessage): AgentMessage {
	if (message.role !== "custom") return message;
	if (typeof message.content === "string") {
		const content = withoutNativeTodoText(message.content);
		return content === message.content ? message : { ...message, content };
	}
	let changed = false;
	const content = message.content.map((part) => {
		if (part.type !== "text") return part;
		const text = withoutNativeTodoText(part.text);
		if (text === part.text) return part;
		changed = true;
		return { ...part, text };
	});
	return changed ? { ...message, content } : message;
}

const isGoalModeContext = (message: AgentMessage): boolean => message.role === "custom" && message.customType === GOAL_MODE_CONTEXT_TYPE;

export function contextMessages(
	messages: AgentMessage[],
	session: AgentSession | undefined,
	state: () => TodoMoreState,
): AgentMessage[] | undefined {
	let stripped = false;
	const own = messages.map((message) => {
		if (!isGoalModeContext(message)) return message;
		const without = withoutNativeTodoContext(message);
		if (without !== message) stripped = true;
		return without;
	});
	const base = stripped ? own : messages;
	if (session?.getGoalModeState()?.enabled !== true) return stripped ? base : undefined;
	const goalIndex = base.findLastIndex(isGoalModeContext);
	const goalMessage = base[goalIndex];
	if (goalMessage === undefined) return stripped ? base : undefined;
	const todoContext = goalTodoContext(session, state());
	if (todoContext === undefined) return stripped ? base : undefined;
	return base.with(goalIndex, withAppendedText(goalMessage, todoContext));
}

class NativeReminderText extends Text {
	constructor(
		text: string,
		private readonly header: string,
	) {
		super(text, 0, 0);
	}

	override describe(): NativeNode {
		return node("card", { role: "todo-more.reminder", tone: "warning", head: [span(this.header, "strong")] });
	}
}

function reminderHeader({ items, attempt, max }: ReminderDetails): string {
	const count = items.length;
	return tr(
		`${count} incomplete ${count === 1 ? "todo" : "todos"} - reminder ${attempt}/${max}`,
		`${count} 个待办未完成 - 提醒 ${attempt}/${max}`,
	);
}

export const renderReminder: MessageRenderer = (message, _options, theme) => {
	const parsed = reminderDetailsSchema.safeParse(message.details);
	if (!parsed.success) return undefined;
	const header = reminderHeader(parsed.data);
	return new NativeReminderText(theme.fg("warning", `${theme.icon.warning} ${header}`), header);
};

export function registerReminders(pi: ExtensionAPI): void {
	const cycle: Cycle = { reminderCount: 0, awaitingProgress: false, mutationsSinceLastTouch: 0, midRunNudgeCount: 0 };
	let pending: PendingContinuation = NO_PENDING;
	let compacted = false;
	let settings: TodoMoreSettings = DEFAULT_SETTINGS;
	const refreshSettings = async (ctx: ExtensionContext): Promise<void> => {
		settings = await readSettings(pi, ctx);
	};

	pi.registerMessageRenderer(REMINDER_TYPE, renderReminder);

	const startSession = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const session = ownSession(ctx);
			if (session !== undefined) silenceNativeTodoAutomation(session);
		} catch (error) {
			pi.logger.warn("todo-more could not switch off the native todo reminders", { error: errorText(error) });
		}
		await refreshSettings(ctx);
	};
	pi.on("session_start", (_event, ctx) => startSession(ctx));
	pi.on("session_switch", (_event, ctx) => startSession(ctx));

	pi.on("session_stop", (event, ctx) => {
		try {
			if (ctx.agent.kind !== "main") return undefined;
			if (!event.stop_hook_active) cycle.reminderCount = 0;
			const session = ownSession(ctx);
			const message = terminalAnswer(event.last_assistant_message);
			if (session === undefined || message === undefined) return undefined;
			const completion = checkCompletion(session, settings, cycle, cycle.reminderCount, message, facts(ctx).state);
			switch (completion.kind) {
				case "silent":
					return undefined;
				case "reset":
					cycle.reminderCount = 0;
					cycle.awaitingProgress = false;
					return undefined;
				case "remind":
					pending = { kind: "main", text: completion.text, details: completion.details, countBefore: cycle.reminderCount };
					cycle.reminderCount = completion.attempt;
					cycle.mutationsSinceLastTouch = 0;
					cycle.awaitingProgress = true;
					return { continue: true, additionalContext: completion.text };
				default: {
					const unreachable: never = completion;
					throw new Error(`Unexpected completion: ${String(unreachable)}`);
				}
			}
		} catch (error) {
			pi.logger.warn("todo-more stop reminder failed", { error: errorText(error) });
			return undefined;
		}
	});

	let cutOff: PendingCutOff | undefined;
	let latch: CutOffLatch = LATCH_OPEN;
	/** Every path that ends a pending reminder goes through here, so its notice never outlives it. */
	const clearCutOff = (): void => {
		if (cutOff === undefined) return;
		const { ctx, timer, wait } = cutOff;
		cutOff = undefined;
		ctx.clearTimer(timer);
		if (wait.kind === "quota" && ctx.hasUI) ctx.ui.setWidget(QUOTA_NOTICE_WIDGET_KEY, undefined);
	};
	const nextStep = ({ ctx, session, message, wait }: CutOffPlan): CutOffStep => {
		if (ownSession(ctx) !== session) return DROP;
		if (wait.kind === "quota") {
			const left = quotaDeadline(wait) - Date.now();
			if (left > 0) return { kind: "wait", ms: Math.min(left, MAX_TIMER_SEGMENT_MS) };
		}
		if (latch.kind !== "open") return DROP;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return DROP;
		if (ctx.hasUI && ctx.ui.getEditorText().trim() !== "") return wait.kind === "quota" ? { kind: "wait", ms: DRAFT_RECHECK_MS } : DROP;
		const completion = checkCompletion(session, settings, cycle, cycle.reminderCount, message, facts(ctx).state);
		return completion.kind === "remind" ? { kind: "remind", completion } : DROP;
	};
	const schedule = (plan: CutOffPlan, ms: number): void => {
		const pending: PendingCutOff = { ...plan, timer: plan.ctx.setTimeout(() => fire(pending), ms) };
		cutOff = pending;
	};
	const fire = (pending: PendingCutOff): void => {
		if (cutOff !== pending) return;
		let waiting = false;
		try {
			const step = nextStep(pending);
			switch (step.kind) {
				case "wait":
					schedule(pending, step.ms);
					waiting = true;
					return;
				case "drop":
					return;
				case "remind": {
					clearCutOff();
					const { completion } = step;
					latch = { kind: "nudged", text: completion.text };
					cycle.reminderCount = completion.attempt;
					cycle.awaitingProgress = true;
					cycle.mutationsSinceLastTouch = 0;
					pi.sendMessage<ReminderDetails>(
						{ customType: REMINDER_TYPE, content: completion.text, display: true, details: completion.details, attribution: "agent" },
						{ deliverAs: "nextTurn", triggerTurn: true },
					);
					return;
				}
				default: {
					const unreachable: never = step;
					throw new Error(`Unexpected cut-off step: ${String(unreachable)}`);
				}
			}
		} catch (error) {
			pi.logger.warn("todo-more cut-off reminder failed", { error: errorText(error) });
		} finally {
			if (!waiting && cutOff === pending) clearCutOff();
		}
	};
	const armCutOff = (ctx: ExtensionContext, session: AgentSession, message: AssistantMessage): void => {
		clearCutOff();
		const wait = cutOffWait(message, Date.now());
		const plan: CutOffPlan = { ctx, session, message, wait };
		switch (wait.kind) {
			case "grace":
				schedule(plan, CUT_OFF_GRACE_MS);
				return;
			case "quota":
				if (ctx.hasUI) {
					ctx.ui.setWidget(QUOTA_NOTICE_WIDGET_KEY, [quotaNoticeLine(wait, CANCEL_SHORTCUT_LABEL, CANCEL_COMMAND)], {
						placement: "aboveEditor",
					});
				}
				schedule(plan, Math.min(quotaDeadline(wait) - Date.now(), MAX_TIMER_SEGMENT_MS));
				return;
			default: {
				const unreachable: never = wait;
				throw new Error(`Unexpected cut-off wait: ${String(unreachable)}`);
			}
		}
	};
	const cancelByHuman = (): boolean => {
		if (cutOff === undefined) return false;
		clearCutOff();
		latch = LATCH_CANCELLED;
		return true;
	};
	const resetCutOffChain = (): void => {
		clearCutOff();
		latch = LATCH_OPEN;
	};
	pi.on("agent_start", () => clearCutOff());
	pi.on("session_shutdown", () => clearCutOff());
	pi.on("session_switch", () => resetCutOffChain());
	pi.on("session_branch", () => resetCutOffChain());
	pi.on("session_tree", () => resetCutOffChain());
	pi.registerShortcut(CANCEL_SHORTCUT, {
		description: tr("Cancel the pending Todo More reminder", "取消待发的 Todo More 提醒"),
		handler: () => {
			cancelByHuman();
		},
	});
	pi.registerCommand(CANCEL_COMMAND, {
		description: tr("Cancel the pending Todo More reminder", "取消待发的 Todo More 提醒"),
		handler: async (_args: string, ctx: ExtensionContext) => {
			const cancelled = cancelByHuman();
			if (ctx.hasUI)
				ctx.ui.notify(
					cancelled ? tr("Todo reminder cancelled", "待办提醒已取消") : tr("No pending Todo reminder", "没有待发的待办提醒"),
					"info",
				);
		},
	});

	pi.on("agent_end", (event, ctx) => {
		try {
			if (event.willContinue === true) return;
			const session = ownSession(ctx);
			if (session === undefined) return;
			const last = event.messages.at(-1);
			if (ctx.agent.kind === "sub") {
				const message = terminalAnswer(last);
				if (message === undefined) return;
				const branch = facts(ctx);
				const completion = checkCompletion(session, settings, cycle, branch.remindersSinceUserMessage, message, branch.state);
				switch (completion.kind) {
					case "silent":
						return;
					case "reset":
						cycle.awaitingProgress = false;
						return;
					case "remind":
						pending = { kind: "sub", text: completion.text };
						cycle.mutationsSinceLastTouch = 0;
						cycle.awaitingProgress = true;
						pi.sendMessage<ReminderDetails>(
							{ customType: REMINDER_TYPE, content: completion.text, display: true, details: completion.details, attribution: "agent" },
							{ deliverAs: "nextTurn", triggerTurn: true },
						);
						return;
					default: {
						const unreachable: never = completion;
						throw new Error(`Unexpected completion: ${String(unreachable)}`);
					}
				}
			}
			const cutOff = cutOffAnswer(last);
			if (cutOff === undefined) return;
			const completion = checkCompletion(session, settings, cycle, cycle.reminderCount, cutOff, facts(ctx).state);
			switch (completion.kind) {
				case "silent":
					return;
				case "reset":
					cycle.reminderCount = 0;
					cycle.awaitingProgress = false;
					return;
				case "remind":
					// T3 owns turn startup, including provider errors and quota waits.
					if (!isT3Host() && latch.kind === "open") armCutOff(ctx, session, cutOff);
					return;
				default: {
					const unreachable: never = completion;
					throw new Error(`Unexpected completion: ${String(unreachable)}`);
				}
			}
		} catch (error) {
			pi.logger.warn("todo-more stop reminder failed", { error: errorText(error) });
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const own = pending;
			pending = NO_PENDING;
			if (latch.kind !== "nudged" || event.prompt !== latch.text) latch = LATCH_OPEN;
			switch (own.kind) {
				case "none":
					break;
				case "main":
					if (event.prompt === own.text) {
						ctx.ui.notify(reminderHeader(own.details), "info");
						return undefined;
					}
					cycle.reminderCount = own.countBefore;
					break;
				case "sub":
					if (event.prompt === own.text) return undefined;
					break;
				default: {
					const unreachable: never = own;
					throw new Error(`Unexpected pending continuation: ${String(unreachable)}`);
				}
			}
			resetCycle(cycle);
			const afterCompaction = compacted;
			compacted = false;
			const session = ownSession(ctx);
			if (session === undefined) return undefined;
			// Also here: a session that never emitted session_start must not run the native reminders beside these.
			silenceNativeTodoAutomation(session);
			await refreshSettings(ctx);
			const prelude = eagerTodoPrelude(pi, session, settings, facts(ctx).state, afterCompaction ? undefined : event.prompt);
			return prelude === undefined ? undefined : { message: prelude };
		} catch (error) {
			pi.logger.warn("todo-more prompt start failed", { error: errorText(error) });
			return undefined;
		}
	});

	pi.on("auto_compaction_end", (event) => {
		if (!event.aborted && event.result !== undefined) compacted = true;
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "toolResult") return;
		onToolResult(cycle, message.toolName, message.isError);
		if (!message.isError) latch = LATCH_OPEN;
	});

	pi.on("turn_end", (event, ctx) => {
		try {
			if (event.toolResults.length === 0) return;
			const session = ownSession(ctx);
			if (session === undefined) return;
			const nudge = takeMidRunNudge(session, settings, cycle, facts(ctx).state);
			if (nudge !== undefined) pi.sendMessage(nudge, { deliverAs: "aside" });
		} catch (error) {
			pi.logger.warn("todo-more mid-run nudge failed", { error: errorText(error) });
		}
	});

	pi.on("context", (event, ctx) => {
		try {
			const messages = contextMessages(event.messages, ownSession(ctx), () => facts(ctx).state);
			return messages === undefined ? undefined : { messages };
		} catch (error) {
			pi.logger.warn("todo-more context failed", { error: errorText(error) });
			return undefined;
		}
	});
}
