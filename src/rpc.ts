/**
 * Text shared by the Todo panel and the non-TUI `/todo-more` notification.
 */
import { tr } from "../omomp-shared/i18n.ts";
import {
	commitRecordText,
	commitScopeText,
	explanationText,
	itemCount,
	type ItemTime,
	type TodoGoal,
	type TodoMoreState,
	type TodoStatus,
} from "./state.ts";

export function goalTextLines(goal: TodoGoal): string[] {
	return [
		`${tr("Objective", "目标")}: ${goal.objective}`,
		`${tr("Measure", "衡量方式")}: ${goal.measure}`,
		`${tr("Done when", "完成条件")}: ${goal.doneWhen}`,
	];
}

export function estimateText(time: ItemTime): string {
	return time.kind === "estimated"
		? `${tr("Estimate", "预计")}: ${time.minutes} ${tr("min", "分钟")}`
		: tr("(no time estimate yet: add one with ESTIMATE)", "（尚无时间估计：请使用 ESTIMATE 添加）");
}

export function statusText(status: TodoStatus): string {
	switch (status) {
		case "pending":
			return tr("pending", "待处理");
		case "in_progress":
			return tr("in progress", "进行中");
		case "completed":
			return tr("completed", "已完成");
		case "abandoned":
			return tr("abandoned", "已放弃");
		case "blocked":
			return tr("blocked", "已阻塞");
		default: {
			const unreachable: never = status;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
}

/** The readable list `/todo-more` prints when no TUI is mounted. */
export function snapshotText(state: TodoMoreState): string {
	if (state.kind === "empty") return tr("Todo More: the list is empty.", "Todo More：待办列表为空。");
	const total = itemCount(state.phases);
	const closed = state.phases.reduce((count, phase) => count + phase.items.filter((item) => item.status === "completed" || item.status === "abandoned").length, 0);
	const lines = [`Todo More — ${closed}/${total} ${tr("done", "已完成")}`];
	if (state.goal.kind === "set") lines.push(...goalTextLines(state.goal.goal));
	else lines.push(tr("Goal: [missing]", "目标：[缺少]"));
	for (const phase of state.phases) {
		lines.push("", `[${phase.name}]`);
		for (const item of phase.items) {
			lines.push(`  [${statusText(item.status)}] ${item.title}`, `    ${estimateText(item.time)}`, `    ${explanationText(item)}`);
			if (item.blocker !== undefined) lines.push(`    ${tr("Blocker", "阻塞原因")}: ${item.blocker}`);
			if (item.commit !== undefined) {
				lines.push(`    ${tr("Commit", "提交")}: ${commitRecordText(item.commit)} (${commitScopeText(item.commit.scope)})`);
			}
		}
	}
	return lines.join("\n");
}
