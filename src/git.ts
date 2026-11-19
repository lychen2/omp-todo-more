import { isAbsolute } from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { errorText } from "./errors.ts";
import { withModelTrailers } from "./models.ts";
import type { CommitRecord, CommitScope } from "./state.ts";

export type WorktreeState =
	| { readonly kind: "no-repository" }
	| { readonly kind: "clean"; readonly root: string }
	| { readonly kind: "dirty"; readonly root: string }
	| { readonly kind: "failed"; readonly message: string };

export type CommitOutcome =
	| { readonly kind: "committed"; readonly root: string; readonly commit: CommitRecord }
	| { readonly kind: "inert"; readonly because: "no-repository" | "clean" }
	| { readonly kind: "failed"; readonly message: string };

function repositoryAt(cwd: string): VcsGitRepo | null {
	try {
		return vcs.git(cwd);
	} catch {
		return null;
	}
}

function failureText(error: unknown): string {
	if (!vcs.isVcsError(error)) return errorText(error);
	return error.stderr.trim() || error.stdout.trim() || error.message.trim() || `exit code ${error.exitCode}`;
}

export async function worktreeState(cwd: string): Promise<WorktreeState> {
	const repo = repositoryAt(cwd);
	if (repo === null) return { kind: "no-repository" };
	const root = repo.primaryRoot();
	try {
		const dirty = await repo.isDirty();
		return dirty ? { kind: "dirty", root } : { kind: "clean", root };
	} catch (error) {
		return { kind: "failed", message: `Cannot read the working tree of ${root}: ${failureText(error)}` };
	}
}

export function sharedWorktreeRoot(cwd: string, otherCwd: string): string | null {
	const root = repositoryAt(cwd)?.info().repoRoot;
	if (root === undefined) return null;
	return repositoryAt(otherCwd)?.info().repoRoot === root ? root : null;
}

export async function commitCompletion(
	cwd: string,
	scope: CommitScope,
	message: string,
	models: readonly string[],
): Promise<CommitOutcome> {
	const repo = repositoryAt(cwd);
	if (repo === null) return { kind: "inert", because: "no-repository" };
	const root = repo.primaryRoot();
	const prefix = repo.prefixOf(cwd) ?? "";
	const files =
		scope.kind === "all" ? undefined : scope.files.map((file) => (isAbsolute(file) || prefix === "" ? file : `${prefix}${file}`));
	try {
		if (!(await repo.isDirty())) return { kind: "inert", because: "clean" };
		if (files === undefined) {
			await repo.stageFiles([]);
		} else {
			await repo.stageFiles([...files]);
			if ((await repo.changedFiles({ cached: true, files: [...files] })).length === 0) {
				return {
					kind: "failed",
					message: `The scope ${JSON.stringify(files.join(" "))} staged nothing in ${root}; name pathspecs that match the work, or omit the scope to commit every change.`,
				};
			}
		}
		const commit: CommitRecord = {
			sha: await repo.commitCreate(withModelTrailers(message, models), files === undefined ? {} : { files: [...files] }),
			message,
			scope: files === undefined ? scope : { kind: "paths", files },
		};
		return { kind: "committed", root, commit };
	} catch (error) {
		return { kind: "failed", message: `git commit failed in ${root}: ${failureText(error)}` };
	}
}
