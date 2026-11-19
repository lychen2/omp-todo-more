import * as jsc from "bun:jsc";
import { mkdirSync } from "node:fs";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type SessionEntry, z } from "@oh-my-pi/pi-coding-agent";
import {
	appendCompactionWithSnapshot,
	type Fixture,
	fillBranch,
	fixture,
	messageEntry,
	referenceCall,
	SNAPSHOT_ENTRY_TYPE,
} from "../post-compact-hint-fixture.ts";

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i] ?? "", Bun.argv[i + 1] ?? "");
const scenario = args.get("--scenario") ?? "";
const calls = Number(args.get("--calls") ?? "50");
const appends = Number(args.get("--appends") ?? "500");
const BRANCH_SIZE = 10_000;

let failed = false;
const fail = (message: string): void => {
	failed = true;
	console.error(`FAIL ${message}`);
};
const ok = (message: string): void => console.log(`ok   ${message}`);

const benchDir = `/tmp/pch-bench-${process.pid}`;
mkdirSync(benchDir, { recursive: true });

function makeFixture(name: string): Fixture {
	const fx = fixture(`${benchDir}/${name}`);
	fillBranch(fx.raw, BRANCH_SIZE);
	return fx;
}

function messagesOf(fx: Fixture): AgentMessage[] {
	const messages: AgentMessage[] = [];
	if (fx.raw.getBranchView().some((entry) => entry.type === "compaction")) {
		messages.push({ role: "compactionSummary", summary: "compacted", tokensBefore: 100_000, timestamp: 0 } as AgentMessage);
	}
	messages.push({ role: "user", content: [{ type: "text", text: "prompt" }], timestamp: 0 } as AgentMessage);
	return messages;
}

const event = (fx: Fixture): { type: "context"; messages: AgentMessage[] } => ({ type: "context", messages: messagesOf(fx) });

const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const referenceCallAsync = async (fx: Fixture, ev: { type: "context"; messages: AgentMessage[] }) => referenceCall(fx, ev);

function warningsCheck(fx: Fixture, label: string): void {
	if (fx.warnings.length > 0) fail(`${label}: handler warned: ${fx.warnings.join(" | ")}`);
}

async function scenarioUnchanged(): Promise<void> {
	const fx = makeFixture("unchanged");
	const ev = event(fx);
	const reference = referenceCall(fx, ev);
	const first = await fx.call(ev.messages);
	if (!jsonEqual(first, reference)) fail(`cold call output differs from reference`);
	let totalReads = 0;
	for (let i = 0; i < calls - 1; i++) {
		fx.resetCounters();
		const result = await fx.call(ev.messages);
		totalReads += fx.counters.reads;
		if (fx.counters.copies !== 0) fail(`call ${i + 2}: ${fx.counters.copies} branch copies`);
		if (!jsonEqual(result, reference)) fail(`call ${i + 2}: output differs from reference`);
	}
	warningsCheck(fx, "unchanged");
	if (totalReads !== 0) fail(`calls 2..${calls}: ${totalReads} entry reads (want 0)`);
	else ok(`${calls} calls: 0 copies, 0 reads after cold call, outputs identical`);
}

async function scenarioAppended(): Promise<void> {
	const fx = makeFixture("appended");
	await fx.call();
	for (let i = 0; i < appends; i++) messageEntry(fx.raw, BRANCH_SIZE + i);
	const ev = event(fx);
	const reference = referenceCall(fx, ev);
	fx.resetCounters();
	const result = await fx.call(ev.messages);
	if (fx.counters.copies !== 0) fail(`${fx.counters.copies} branch copies`);
	if (fx.counters.reads > appends + 1) fail(`${fx.counters.reads} reads > ${appends} appended + 1 ancestor probe`);
	if (!jsonEqual(result, reference)) fail(`output differs from reference`);
	if (!failed) ok(`+${appends} entries: ${fx.counters.reads} reads (≤ ${appends + 1}), 0 copies, output identical`);
	fx.resetCounters();
	const again = await fx.call(ev.messages);
	if (fx.counters.reads !== 0) fail(`steady call: ${fx.counters.reads} reads (want 0)`);
	if (!jsonEqual(again, reference)) fail(`steady output differs`);
	warningsCheck(fx, "appended");
}

async function scenarioRendered(): Promise<void> {
	const fx = makeFixture("rendered");
	appendCompactionWithSnapshot(fx.raw);
	const ev = event(fx);
	const reference = referenceCall(fx, ev);
	const result = await fx.call(ev.messages);
	if (!jsonEqual(result, reference)) fail(`rendered output differs from reference`);
	else ok(`rendered: messages byte-identical (payload after compactionSummary)`);
	fx.resetCounters();
	const again = await fx.call(ev.messages);
	if (fx.counters.reads !== 0 || fx.counters.copies !== 0) fail(`steady: ${fx.counters.reads} reads ${fx.counters.copies} copies`);
	if (!jsonEqual(again, reference)) fail(`steady output differs`);
	warningsCheck(fx, "rendered");
}

async function scenarioUnrendered(): Promise<void> {
	const fx = makeFixture("unrendered");
	const compactionId = fx.raw.appendCompaction("summary", undefined, fx.raw.getLeafId() ?? "", 100_000);
	const before = fx.raw.getBranchView().length;
	const ev = event(fx);
	const reference = referenceCall(fx, ev);
	const result = await fx.call(ev.messages);
	if (reference === undefined) {
		const appended = fx.raw.getBranchView().slice(before);
		if (result === undefined) {
			if (appended.length !== 0) fail(`undefined output but ${appended.length} entries appended`);
			else ok(`unrendered: render failed → undefined, no entries (reference-observable)`);
		} else {
			const snapshot = appended.find(
				(entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE,
			);
			if (appended.length !== 1 || snapshot === undefined) fail(`expected 1 snapshot entry, got ${appended.length}`);
			const parsed = z.object({ compactionId: z.string() }).safeParse(snapshot?.data);
			if (!parsed.success || parsed.data.compactionId !== compactionId) fail(`snapshot compactionId ≠ ${compactionId}`);
			const summaryAt = (result?.messages ?? []).findIndex((message) => message.role === "compactionSummary");
			const payloadAt = (result?.messages ?? []).findIndex((message) => message.role === "custom");
			if (payloadAt !== summaryAt + 1) fail(`payload at ${payloadAt}, summary at ${summaryAt}`);
			else ok(`unrendered: snapshot appended + payload after summary (rendered path intact)`);
		}
	}
	if (result !== undefined) {
		const reference2 = referenceCall(fx, ev);
		const next = await fx.call(ev.messages);
		if (!jsonEqual(next, reference2)) fail(`post-append call differs from reference`);
		else ok(`post-append: rendered via suffix scan, byte-identical`);
	}
	for (const warning of fx.warnings) if (!warning.includes("Post-compaction ctx attachment failed")) fail(`unexpected warn: ${warning}`);
}

async function scenarioNavigation(): Promise<void> {
	const fx = makeFixture("navigation");
	appendCompactionWithSnapshot(fx.raw);
	const ev = event(fx);
	await fx.call(ev.messages);
	const view = fx.raw.getBranchView();
	fx.raw.branchWithSummary(view.at(-2)?.id ?? null, "sibling");
	const before = fx.raw.getBranchView().length;
	const ev2 = event(fx);
	fx.resetCounters();
	const result = await fx.call(ev2.messages);
	if (fx.counters.reads === 0) fail(`sibling navigation: 0 reads — offset reused across a leaf change`);
	const appended = fx.raw.getBranchView().slice(before);
	if (result !== undefined) {
		const snapshot = appended.find(
			(entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE,
		);
		if (snapshot === undefined) fail(`payload returned but no snapshot entry appended`);
		else ok(`sibling branch: ${fx.counters.reads} reads (full rescan), unrendered → snapshot appended`);
	} else if (appended.length !== 0) {
		fail(`undefined output but ${appended.length} entries appended`);
	} else {
		ok(`sibling branch: ${fx.counters.reads} reads (full rescan), unrendered → render failed as on old path`);
	}
	const reference2 = referenceCall(fx, ev2);
	const next = await fx.call(ev2.messages);
	if (!jsonEqual(next, reference2)) fail(`post-navigation call differs from reference`);
	else ok(`post-navigation: byte-identical to reference`);
	for (const warning of fx.warnings) if (!warning.includes("Post-compaction ctx attachment failed")) fail(`unexpected warn: ${warning}`);
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function scenarioNoCompaction(): Promise<void> {
	const fx = makeFixture("no-compaction");
	const ev = event(fx);
	await fx.call(); // cold call seeds the offset; steady state is what §4 measures
	const rounds = 30;
	const callsPerRound = 100;
	const refTime: number[] = [];
	const newTime: number[] = [];
	for (let r = 0; r < rounds; r++) {
		const t0 = performance.now();
		for (let i = 0; i < callsPerRound; i++) await referenceCallAsync(fx, ev);
		refTime.push((performance.now() - t0) / callsPerRound);
		const t1 = performance.now();
		for (let i = 0; i < callsPerRound; i++) await fx.call(ev.messages);
		newTime.push((performance.now() - t1) / callsPerRound);
	}
	const refHeap: number[] = [];
	const refArrays: number[] = [];
	const newHeap: number[] = [];
	const newArrays: number[] = [];
	for (let r = 0; r < 100; r++) {
		jsc.gcAndSweep();
		fx.resetCounters();
		const a0 = jsc.heapStats().objectTypeCounts.Array ?? 0;
		const h0 = process.memoryUsage().heapUsed;
		await referenceCallAsync(fx, ev);
		refHeap.push(process.memoryUsage().heapUsed - h0);
		refArrays.push((jsc.heapStats().objectTypeCounts.Array ?? 0) - a0);
		if (fx.counters.copies !== 1) fail(`reference call copied ${fx.counters.copies}× (want 1)`);
		jsc.gcAndSweep();
		fx.resetCounters();
		const a1 = jsc.heapStats().objectTypeCounts.Array ?? 0;
		const h1 = process.memoryUsage().heapUsed;
		await fx.call(ev.messages);
		newHeap.push(process.memoryUsage().heapUsed - h1);
		newArrays.push((jsc.heapStats().objectTypeCounts.Array ?? 0) - a1);
		if (fx.counters.copies !== 0) fail(`bounded call copied ${fx.counters.copies}× (want 0)`);
	}
	warningsCheck(fx, "no-compaction");
	const mt = median(refTime);
	const nt = median(newTime);
	const mh = median(refHeap);
	const nh = median(newHeap);
	const ma = median(refArrays);
	const na = median(newArrays);
	console.log(`reference: ${(mt * 1000).toFixed(1)} µs/call, ${(mh / 1024).toFixed(1)} KiB heapUsed, +${ma} Array objects (median)`);
	console.log(`new:       ${(nt * 1000).toFixed(1)} µs/call, ${(nh / 1024).toFixed(1)} KiB heapUsed, +${na} Array objects (median)`);
	const timeRatio = mt / nt;
	console.log(`ratios:    ${timeRatio.toFixed(1)}× faster; Array objects/call ${na} vs ${ma}; heapUsed ${nh} vs ${mh} bytes`);
	if (!(nt * 10 <= mt)) fail(`time ratio ${timeRatio.toFixed(1)}× < 10×`);
	if (!(ma >= 1 && na < ma)) fail(`Array objects ${na} not below reference ${ma}`);
}

const scenarios: Record<string, () => Promise<void>> = {
	unchanged: scenarioUnchanged,
	appended: scenarioAppended,
	rendered: scenarioRendered,
	unrendered: scenarioUnrendered,
	navigation: scenarioNavigation,
	"no-compaction": scenarioNoCompaction,
};

const run = scenarios[scenario];
if (run === undefined) {
	console.error(`usage: bun test/bench/post-compact-hint.ts --scenario ${Object.keys(scenarios).join("|")} [--calls N] [--appends N]`);
	process.exit(2);
}
await run();
if (failed) process.exit(1);
