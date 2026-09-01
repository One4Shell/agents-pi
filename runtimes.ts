// Definizioni dei runtime (come costruire il comando di una query).
import type { AgentRuntime, PiAgentConfig, PiRuntime } from "./types.ts";

/** Runtime `pi`: `pi -p <QUERY>` (default). */
export const piRuntime: AgentRuntime = {
	type: "pi",
	bin: "pi",
	buildArgs(prompt: string, cfg: PiAgentConfig): string[] {
		const args = ["-p", prompt];
		if (cfg.model) args.push("--model", cfg.model);
		args.push(...(cfg.extraArgs ?? []));
		return args;
	},
};

/** Runtime `opencode`: `opencode run "<QUERY>"`. */
export const opencodeRuntime: AgentRuntime = {
	type: "opencode",
	bin: "opencode",
	buildArgs(prompt: string, cfg: PiAgentConfig): string[] {
		// Il query viene racchiuso tra virgolette per gestire spazi e parole multiple.
		const args = ["run", `"${prompt.replaceAll('"', '\\"')}"`];
		args.push(...(cfg.extraArgs ?? []));
		return args;
	},
};

/** Mappa dei runtime predefiniti. */
export const runtimes: Record<PiRuntime, AgentRuntime> = {
	pi: piRuntime,
	opencode: opencodeRuntime,
};

/** Recupera il runtime per un tipo, con fallback su `pi`. */
export function resolveRuntime(runtime?: PiRuntime): AgentRuntime {
	return runtime ? runtimes[runtime] : piRuntime;
}
