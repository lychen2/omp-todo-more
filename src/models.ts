import type { BranchFacts } from "./branch.ts";

export type ModelRef = { readonly provider: string; readonly id: string };

export function participatingModels(facts: BranchFacts, current: ModelRef | undefined): string[] {
	const models = current === undefined ? facts.modelsSinceCommit : [...facts.modelsSinceCommit, `${current.provider}/${current.id}`];
	return [...new Set(models)];
}

export function withModelTrailers(message: string, models: readonly string[]): string {
	if (models.length === 0) return message;
	return `${message.trimEnd()}\n\n${models.map((model) => `Model: ${model}`).join("\n")}`;
}
