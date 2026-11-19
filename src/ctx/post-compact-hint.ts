/**
 * Post-compaction roster: after a compaction boundary, every model call of
 * the main session carries the session's `task` subagents as they stood at
 * the compaction, one `ctx list` row each, so the model still knows which
 * agents exist, which are running, and what the finished ones reported.
 *
 * Rationale. The compaction summary is prose about the work and is not a
 * reliable inventory of agent ids; the todo plan is re-delivered by
 * planning.ts's context-delta stream once compaction drops it. The roster
 * carries only what neither does: live agents (running, idle) and finished
 * agents with a result summary, rendered by the `ctx` tool's own row
 * renderer. The current session, its handoff (the summary itself), its
 * goal and task timeline (the todo plan) are not repeated.
 *
 * Delivery. The payload is context, not a message: sending it as a user
 * message starts a model turn of its own (idle) or lands after the final
 * answer (queued steer), and the model then repeats that answer. Instead
 * the `context` hook places it right after the compaction summary in each
 * request. The roster is rendered on the first request after a compaction
 * and persisted as a custom session entry keyed by the compaction entry id
 * (an empty text when no subagent qualifies), so the payload stays
 * byte-identical for every later request until the next compaction, and
 * survives resume. Its header dates the rows, since statuses change after.
 *
 * Scope. Main session only, mirroring tool-policy-nag: subagents run
 * short, decomposed slices and do not benefit from a post-compaction
 * roster.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { branchFacts, contextBranch, POST_COMPACT_SNAPSHOT_TYPE, POST_COMPACT_SNAPSHOT_VERSION } from "../branch.ts";
import { errorText } from "../errors.ts";
import { buildInventory, renderSubagentRoster } from "./inventory.ts";

/** Custom message type of the payload placed into each request. */
const CONTEXT_MESSAGE_TYPE = "todo-more.post-compact-ctx";

function clockTime(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "the compaction";
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The rendered roster block, or "" when no subagent qualifies. */
async function renderRoster(ctx: ExtensionContext): Promise<{ text: string; shown: number; omitted: number }> {
	const inventory = await buildInventory(ctx);
	const roster = await renderSubagentRoster(inventory);
	if (roster === undefined) return { text: "", shown: 0, omitted: 0 };
	const at = inventory.current.latestCompaction ? clockTime(inventory.current.latestCompaction.timestamp) : "the compaction";
	// Delimited block so the model treats the payload as an auto-attached
	// artifact, not as a fresh user instruction that must be acted on.
	const lines = [
		"<post-compact-ctx>",
		`Subagents of this session as of ${at}, when the context was compacted. Statuses may have changed since: \`ctx list\` shows the current ones. \`agent://<id>\` reads a result, \`history://<id>\` a transcript.`,
		"",
		roster.text,
	];
	if (roster.omitted > 0) lines.push("", `${roster.omitted} finished subagent(s) without a result are not listed.`);
	lines.push("</post-compact-ctx>");
	return { text: lines.join("\n"), shown: roster.shown, omitted: roster.omitted };
}

/** `messages` with the payload placed right after the last compaction summary (start of the list when none). */
function withPayload(messages: AgentMessage[], text: string): AgentMessage[] {
	const payload: AgentMessage = {
		role: "custom",
		customType: CONTEXT_MESSAGE_TYPE,
		content: text,
		display: false,
		attribution: "agent",
		timestamp: 0,
	};
	const at = messages.findLastIndex((message) => message.role === "compactionSummary") + 1;
	return [...messages.slice(0, at), payload, ...messages.slice(at)];
}

export function registerPostCompactHint(pi: ExtensionAPI): void {
	pi.on("context", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		try {
			// Sampled before any `await` in this handler.
			const boundary = branchFacts(contextBranch(ctx)).compaction;
			switch (boundary.kind) {
				case "none":
				case "empty":
					return undefined;
				case "rendered":
					return { messages: withPayload(event.messages, boundary.text) };
				case "unrendered": {
					const roster = await renderRoster(ctx);
					pi.appendEntry(POST_COMPACT_SNAPSHOT_TYPE, {
						version: POST_COMPACT_SNAPSHOT_VERSION,
						compactionId: boundary.compactionId,
						text: roster.text,
					});
					pi.logger.info("Post-compaction roster recorded", {
						compactionId: boundary.compactionId,
						shown: roster.shown,
						omitted: roster.omitted,
					});
					return roster.text === "" ? undefined : { messages: withPayload(event.messages, roster.text) };
				}
				default: {
					const unreachable: never = boundary;
					return unreachable;
				}
			}
		} catch (error) {
			pi.logger.warn("Post-compaction roster attachment failed", { error: errorText(error) });
			return undefined;
		}
	});
}
