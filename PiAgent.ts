// Classe per una singola istanza agente: esegue un processo `runtime` con una query.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveRuntime } from "./runtimes.ts";
import type { PiAgentConfig, PiAgentResult, PiAgentState, PiJobSpec, PiRuntime } from "./types.ts";
import { cleanMultilineOutput, parseJsonOutput } from "./utils.ts";

/** Callback di cambio stato (used da widget/job per aggiornare il progresso). */
export type PiAgentStateListener = (state: PiAgentState, agent: PiAgent) => void;

/**
 * Istanza singola di un agente (agente-ai / pi / opencode). Esegue il processo in modo
 * isolato e ne restituisce il risultato pulito.
 */
export class PiAgent {
	readonly id: string;
	readonly label: string;
	readonly config: PiAgentConfig;
	readonly runtime: PiRuntime;

	private state: PiAgentState = "queued";
	private listeners: PiAgentStateListener[] = [];

	constructor(
		private pi: ExtensionAPI,
		spec: PiJobSpec,
	) {
		this.id = spec.id;
		this.label = spec.label;
		this.config = spec.config;
		this.runtime = spec.config.runtime ?? "agente-ai";
	}

	getState(): PiAgentState {
		return this.state;
	}

	onState(listener: PiAgentStateListener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	private setState(state: PiAgentState): void {
		this.state = state;
		for (const l of this.listeners) l(state, this);
	}

	/**
	 * Esegue l'istanza e attende il risultato. Non lancia mai: se il processo
	 * termina con codice di uscita ≠ 0, o se l'output è vuoto (dopo un retry),
	 * restituisce un risultato con `state: "failed"` ed `error` valorizzato.
	 * Un eventuale `signal` interrompe il processo e riporta lo stato "failed"
	 * con errore "Annullato" (nessun retry).
	 */
	async run(signal?: AbortSignal): Promise<PiAgentResult> {
		const runtime = resolveRuntime(this.runtime);
		const buildArgs = runtime.buildArgs;
		const args = buildArgs(this.config.prompt, this.config);

		const startedAt = Date.now();
		this.setState("running");

		let lastRaw = "";
		let lastStderr = "";
		let lastExitCode = 0;
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt > 0) this.setState("retry");
			const res = await this.pi.exec(runtime.bin, args, { signal });
			lastRaw = res.stdout ?? "";
			lastStderr = res.stderr ?? "";
			lastExitCode = res.code ?? 0;
			if (signal?.aborted) break;
			if (lastExitCode !== 0) break;
			if (lastRaw.trim()) break;
		}

		const durationMs = Date.now() - startedAt;

		if (signal?.aborted) {
			this.setState("failed");
			return {
				id: this.id,
				label: this.label,
				runtime: this.runtime,
				output: "",
				rawOutput: lastRaw,
				exitCode: lastExitCode,
				state: "failed",
				durationMs,
				error: "Annullato",
			};
		}

		if (lastExitCode !== 0) {
			const error = lastStderr.trim() || lastRaw.trim() || `Processo terminato con codice ${lastExitCode}`;
			this.setState("failed");
			return {
				id: this.id,
				label: this.label,
				runtime: this.runtime,
				output: cleanMultilineOutput(lastRaw),
				rawOutput: lastRaw,
				exitCode: lastExitCode,
				state: "failed",
				durationMs,
				error: error || `Processo terminato con codice ${lastExitCode}`,
			};
		}

		// Output vuoto dopo i tentativi: consideriamo l'istanza fallita.
		if (!lastRaw.trim()) {
			this.setState("failed");
			return {
				id: this.id,
				label: this.label,
				runtime: this.runtime,
				output: "",
				rawOutput: lastRaw,
				exitCode: lastExitCode,
				state: "failed",
				durationMs,
				error: "Il modello non ha restituito testo.",
			};
		}

		this.setState("done");
		return {
			id: this.id,
			label: this.label,
			runtime: this.runtime,
			output: cleanMultilineOutput(lastRaw),
			json: parseJsonOutput(lastRaw) ?? undefined,
			rawOutput: lastRaw,
			exitCode: lastExitCode,
			state: "done",
			durationMs,
		};
	}
}
