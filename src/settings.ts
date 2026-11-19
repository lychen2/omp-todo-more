import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { cfgTodoEager, cfgTodoReminders } from "@oh-my-pi/pi-coding-agent/tools/settings";
import manifest from "../package.json";
import { errorText } from "./errors.ts";

const PLUGIN = "omp-todo-more";
const defaults = manifest.omp.settings;

export const EAGER_MODES = ["default", "preferred", "always"] as const;
export type EagerMode = (typeof EAGER_MODES)[number];

export type TodoMoreSettings = {
	readonly reminders: boolean;
	readonly remindersMax: number;
	readonly eager: EagerMode;
	readonly leafMaxMinutes: number;
};

export const DEFAULT_SETTINGS: TodoMoreSettings = {
	reminders: defaults.reminders.default,
	remindersMax: defaults.remindersMax.default,
	eager: "default",
	leafMaxMinutes: defaults.leafMaxMinutes.default,
};

function isEagerMode(value: unknown): value is EagerMode {
	return EAGER_MODES.some((mode) => mode === value);
}

function pick<T>(raw: unknown, valid: (value: unknown) => value is T, fallback: T, key: string, invalid: string[]): T {
	if (raw === undefined) return fallback;
	if (valid(raw)) return raw;
	invalid.push(key);
	return fallback;
}

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const integerIn =
	(range: { readonly min: number; readonly max: number }) =>
	(value: unknown): value is number =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= range.min && value <= range.max;
const isCount = integerIn(defaults.remindersMax);
const isLeafMax = integerIn(defaults.leafMaxMinutes);

export async function readSettings(pi: Pick<ExtensionAPI, "logger">, ctx: Pick<ExtensionContext, "cwd">): Promise<TodoMoreSettings> {
	try {
		const raw = await getPluginSettings(PLUGIN, ctx.cwd);
		const invalid: string[] = [];
		const settings: TodoMoreSettings = {
			reminders: pick(raw.reminders, isBoolean, DEFAULT_SETTINGS.reminders, "reminders", invalid),
			remindersMax: pick(raw.remindersMax, isCount, DEFAULT_SETTINGS.remindersMax, "remindersMax", invalid),
			eager: pick(raw.eager, isEagerMode, DEFAULT_SETTINGS.eager, "eager", invalid),
			leafMaxMinutes: pick(raw.leafMaxMinutes, isLeafMax, DEFAULT_SETTINGS.leafMaxMinutes, "leafMaxMinutes", invalid),
		};
		if (invalid.length > 0) pi.logger.warn("todo-more ignored invalid plugin settings", { keys: invalid });
		return settings;
	} catch (error) {
		pi.logger.warn("todo-more could not read its plugin settings", { error: errorText(error) });
		return DEFAULT_SETTINGS;
	}
}

export function silenceNativeTodoAutomation(session: AgentSession): void {
	if (cfgTodoReminders.get(session.settings)) cfgTodoReminders.override(session.settings, false);
	if (cfgTodoEager.get(session.settings) !== "default") cfgTodoEager.override(session.settings, "default");
}
