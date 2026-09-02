/** Stati osservabili di un'istanza agente (un processo `pi` / `opencode` / `agente-ai.sh`). */
export type PiAgentState = "queued" | "running" | "retry" | "done" | "failed";

/** Runtime disponibili per avviare un'istanza. */
export type PiRuntime = "pi" | "opencode" | "agente-ai";

/** Configurazione di un singolo agente. */
export interface PiAgentConfig {
	/** Prompt/query da inviare all'agente. */
	prompt: string;
	/**
	 * Runtime da usare: `"agente-ai"` (default, `scripts/agente-ai.sh "<QUERY>"`),
	 * `"pi"` (`pi -p <QUERY>`) oppure `"opencode"` (`opencode run "<QUERY>"`).
	 * Se non specificato usa `agente-ai`.
	 */
	runtime?: PiRuntime;
	/** Modello specifico (flag `--model <MODEL>` per `pi`, `-m <MODEL>` per `agente-ai`). */
	model?: string;
	/** Argomenti aggiuntivi da accodare al comando. */
	extraArgs?: string[];
}

/** Specifica di un agente da eseguire (id + etichetta + configurazione). */
export interface PiJobSpec {
	id: string;
	label: string;
	config: PiAgentConfig;
}

/**
 * Metadati opzionali di un'istanza agente mostrati dal widget di progresso
 * accanto alla barra (runtime, modello, anteprima prompt).
 */
export interface PiAgentMeta {
	runtime?: PiRuntime;
	model?: string;
	prompt?: string;
}

/** Risultato di un'istanza agente al termine dell'esecuzione. */
export interface PiAgentResult {
	id: string;
	label: string;
	runtime: PiRuntime;
	/** Output pulito (ANSI/markdown rimossi). */
	output: string;
	/** JSON già parsato, presente solo se l'output è un oggetto/array JSON valido. */
	json?: unknown;
	/** Uscita grezza dal processo. */
	rawOutput: string;
	exitCode: number;
	state: PiAgentState;
	/** Durata effettiva dell'esecuzione in ms. */
	durationMs?: number;
	/** Presente solo se l'istanza è fallita. */
	error?: string;
}

/** Definizione di un runtime: come costruire gli argomenti CLI per una query. */
export interface AgentRuntime {
	type: PiRuntime;
	/** Nome del binario (es. "pi", "opencode") o percorso assoluto dello script. */
	bin: string;
	/** Costruisce gli argomenti per `pi.exec(bin, args)`. */
	buildArgs(prompt: string, cfg: PiAgentConfig): string[];
}
