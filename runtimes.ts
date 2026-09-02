// Definizioni dei runtime (come costruire il comando di una query).
import type { AgentRuntime, PiAgentConfig, PiRuntime } from "./types.ts";

/** Percorso assoluto dello script `agente-ai.sh` (in `scripts/` accanto a questo modulo). */
const AGENTE_AI_SCRIPT = new URL("./scripts/agente-ai.sh", import.meta.url).pathname;

/** Runtime `pi`: `pi -p <QUERY>`. */
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

/**
 * Runtime `agente-ai`: `scripts/agente-ai.sh "<QUERY>"` (default).
 * Client CLI stateless per API compatibili OpenAI; endpoint/modello/key
 * configurabili via env (`OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`),
 * oppure per task con `model` (flag `-m`) ed `extraArgs`.
 */
export const agenteAiRuntime: AgentRuntime = {
	type: "agente-ai",
	bin: AGENTE_AI_SCRIPT,
	buildArgs(prompt: string, cfg: PiAgentConfig): string[] {
		const args: string[] = [];
		if (cfg.model) args.push("-m", cfg.model);
		args.push(prompt);
		args.push(...(cfg.extraArgs ?? []));
		return args;
	},
};

/** Mappa dei runtime predefiniti. */
export const runtimes: Record<PiRuntime, AgentRuntime> = {
	"agente-ai": agenteAiRuntime,
	pi: piRuntime,
	opencode: opencodeRuntime,
};

/** Recupera il runtime per un tipo, con fallback su `agente-ai`. */
export function resolveRuntime(runtime?: PiRuntime): AgentRuntime {
	return runtime ? runtimes[runtime] : agenteAiRuntime;
}
