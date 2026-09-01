// Classe per esecuzioni multicorrente (job) di più istanze agente in parallelo,
// con limite di concorrenza configurabile e aggiornamento opzionale di un widget.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiAgent } from "./PiAgent.ts";
import type { PiProgressWidget } from "./PiProgressWidget.ts";
import type { PiAgentResult, PiJobSpec } from "./types.ts";

export interface PiJobOptions {
	/** Numero massimo di istanze eseguite contemporaneamente (default 1). */
	maxConcurrent?: number;
	/** Widget di progresso da aggiornare ad ogni transizione (opzionale). */
	widget?: PiProgressWidget;
}

/**
 * Gestisce un insieme di agenti da eseguire in parallelo con un semaforo di
 * concorrenza. `runAll()` risolve con i risultati di tutte le istanze.
 */
export class PiJob {
	private pi: ExtensionAPI;
	private specs: PiJobSpec[];
	private maxConcurrent: number;
	private widget?: PiProgressWidget;

	private agents: PiAgent[] = [];
	private startedAt = 0;

	constructor(pi: ExtensionAPI, specs: PiJobSpec[], options: PiJobOptions = {}) {
		this.pi = pi;
		this.specs = specs;
		this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
		this.widget = options.widget;
	}

	/** Restituisce le istanze create (quando in esecuzione / al termine). */
	getAgents(): PiAgent[] {
		return this.agents;
	}

	elapsedMs(): number {
		return this.startedAt ? Date.now() - this.startedAt : 0;
	}

	/**
	 * Esegue tutti gli agenti in parallelo rispettando `maxConcurrent`.
	 * Non lancia mai: gli agenti falliti riportano un risultato con `state: "failed"`.
	 * Un eventuale `signal` viene propagato alle singole istanze (cancellazione).
	 */
	async runAll(signal?: AbortSignal): Promise<PiAgentResult[]> {
		this.startedAt = Date.now();
		this.widget?.reset();
		this.agents = this.specs.map((spec) => {
			const agent = new PiAgent(this.pi, spec);
			agent.onState((state, a) => {
				this.widget?.update(a.id, state);
			});
			return agent;
		});
		for (const agent of this.agents) this.widget?.register(agent.id, agent.label);

		const results: PiAgentResult[] = new Array(this.specs.length);
		let next = 0;
		let running = 0;

		await new Promise<void>((resolve) => {
			const pump = (): void => {
				while (running < this.maxConcurrent && next < this.agents.length) {
					const index = next++;
					running++;
					const agent = this.agents[index]!;
					agent
						.run(signal)
						.then((result) => {
							results[index] = result;
						})
						.catch((err: unknown) => {
							results[index] = {
								id: agent.id,
								label: agent.label,
								runtime: agent.runtime,
								output: "",
								rawOutput: "",
								exitCode: -1,
								state: "failed",
								error: err instanceof Error ? err.message : String(err),
							};
						})
						.finally(() => {
							running--;
							pump();
							if (running === 0 && next >= this.agents.length) resolve();
						});
				}
			};
			pump();
		});

		this.widget?.finish();
		return results;
	}
}
