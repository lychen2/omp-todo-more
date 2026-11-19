import { readFileSync } from "node:fs";

export function todoDocTopics(): Readonly<Record<string, string>> {
	return {
		protocol: readFileSync(new URL("./topics/todo-protocol.md", import.meta.url), "utf8"),
		lifecycle: readFileSync(new URL("./topics/todo-lifecycle.md", import.meta.url), "utf8"),
	};
}
