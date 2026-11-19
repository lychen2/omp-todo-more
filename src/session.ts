import { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

export function sessionOf(agentId: string): AgentSession | undefined {
	const session = AgentRegistry.global().get(agentId)?.session;
	return session instanceof AgentSession ? session : undefined;
}
