import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export function isT3Host(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env.T3_MCP_URL || env.T3_PI_MCP_EXTENSION_PATH);
}

export async function t3ParentCwd(events: ExtensionAPI["events"] | undefined): Promise<string | undefined> {
	if (!isT3Host()) return undefined;
	const channel = "omp-t3:parent-cwd:v1";
	if (!events?.hasListeners(channel)) throw new Error("T3 parent lookup is unavailable: restart this thread with the updated omp-t3 bridge");
	const pending = Promise.withResolvers<unknown>();
	const signal = AbortSignal.timeout(16_000); // Allows 10s for MCP startup and 5s for the lookup.
	const onAbort = (): void => pending.reject(new Error("T3 parent lookup timed out"));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		events.emit(channel, { reply: pending.resolve });
		const value = await pending.promise;
		if (typeof value !== "object" || value === null || !("kind" in value)) throw new Error("T3 parent lookup returned invalid metadata");
		if (value.kind === "top-level") return undefined;
		if (value.kind === "parent" && "cwd" in value && typeof value.cwd === "string" && value.cwd.startsWith("/")) return value.cwd;
		throw new Error("T3 parent relationship could not be verified; retry DONE when the T3 connection is available");
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
