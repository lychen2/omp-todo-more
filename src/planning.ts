import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createDeltaStream, type Delta } from "../omomp-shared/context-delta.ts";
import { branchFacts, contextBranch } from "./branch.ts";
import { errorText } from "./errors.ts";
import { type TodoMoreState, toSnapshot } from "./state.ts";

const INIT_REMINDER =
	'Todo is empty. Multi-step work (several dependent changes, or work spanning more than one turn): initialize with one complete Todo document: INIT "objective" "measure" "doneWhen", PHASE "name", and ADD "title" "explanation" minutes for every step, between *** Begin Todo and *** End Todo. Estimate each item yourself in positive integer minutes; no fractions or defaults. A single quick change, a command the user asked to run, discussion, investigation, explanation and questions need no todo.';

function reminderBody(state: TodoMoreState): string {
	switch (state.kind) {
		case "empty":
			return INIT_REMINDER;
		case "list":
			return [
				'Discussion, investigation, explanation and questions add no items. Check that this todo matches your current plan and latest user instructions. Update the goal, steps, explanations, estimates and statuses wherever they disagree; do not omit or narrow work. The complete snapshot includes completed, abandoned and blocked items. A null goal/explanation is missing; time.kind missing requires ESTIMATE "title" minutes with your own positive integer estimate. Batch related changes in one Todo document. Budgets are forecasts, not permission to reduce scope or quality. You do not need VIEW to check this snapshot.',
				JSON.stringify(toSnapshot(state), null, 2),
			].join("\n");
		default: {
			const unreachable: never = state;
			throw new Error(`Unexpected todo-more state: ${String(unreachable)}`);
		}
	}
}

export function registerPlanning(pi: ExtensionAPI): void {
	const deltas = createDeltaStream("omp-todo-more/planning");
	const current = (ctx: ExtensionContext): Delta => ({
		kind: "text",
		body: reminderBody(branchFacts(contextBranch(ctx)).state),
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (event.reason === "revive") return;
		try {
			return deltas.atPrompt(ctx, current(ctx));
		} catch (error) {
			pi.logger.warn("todo-more user-message reminder failed", { error: errorText(error) });
		}
	});
	pi.on("tool_result", (_event, ctx) => {
		try {
			return deltas.afterTools(ctx, current(ctx));
		} catch (error) {
			pi.logger.warn("todo-more todo snapshot reminder failed", { error: errorText(error) });
		}
	});
	pi.on("turn_start", () => deltas.turnStarted());
}
