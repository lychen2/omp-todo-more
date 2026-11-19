import { type AssistantMessage, calculateRateLimitBackoffMs, isUsageLimitOutcome, parseRateLimitReason } from "@oh-my-pi/pi-ai";
import { extractRetryHint } from "@oh-my-pi/pi-utils";
import { tr } from "../omomp-shared/i18n.ts";

export const QUOTA_RESET_MARGIN_MS = 60_000;

export type QuotaResetSource = "hint" | "estimate";

export type QuotaWait = { readonly kind: "quota"; readonly resetAt: number; readonly source: QuotaResetSource };

export type CutOffWait = { readonly kind: "grace" } | QuotaWait;

const GRACE: CutOffWait = { kind: "grace" };

export function cutOffWait(message: AssistantMessage, now: number): CutOffWait {
	const errorMessage = message.errorMessage;
	if (message.stopReason !== "error" || message.errorStatus !== 429 || errorMessage === undefined) return GRACE;
	if (!isUsageLimitOutcome(429, errorMessage)) return GRACE;
	const hint = extractRetryHint(undefined, errorMessage);
	return hint === undefined
		? { kind: "quota", resetAt: now + calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage)), source: "estimate" }
		: { kind: "quota", resetAt: now + hint, source: "hint" };
}

export const quotaDeadline = (wait: QuotaWait): number => wait.resetAt + QUOTA_RESET_MARGIN_MS;

function clock(ms: number): string {
	const date = new Date(ms);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function quotaNoticeLine(wait: QuotaWait, cancelKey: string, cancelCommand: string): string {
	const reason =
		wait.source === "hint"
			? tr(`account quota 429, resets ${clock(wait.resetAt)}`, `账户配额 429，将于 ${clock(wait.resetAt)} 重置`)
			: tr(`account quota 429, reset estimated ${clock(wait.resetAt)}`, `账户配额 429，预计于 ${clock(wait.resetAt)} 重置`);
	return tr(
		`Todo reminder scheduled for ${clock(quotaDeadline(wait))} (${reason}) · ${cancelKey} or /${cancelCommand} to cancel`,
		`待办提醒计划于 ${clock(quotaDeadline(wait))} 发送（${reason}）· 按 ${cancelKey} 或 /${cancelCommand} 取消`,
	);
}
