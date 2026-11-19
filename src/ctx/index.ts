import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerCtxTool } from "./inventory.ts";
import { registerPostCompactHint } from "./post-compact-hint.ts";

export function registerCtx(pi: ExtensionAPI): void {
	registerCtxTool(pi);
	registerPostCompactHint(pi);
}
