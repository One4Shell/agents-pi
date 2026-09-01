/** Stati osservabili di un'istanza agente (un processo `pi` / `opencode`). */
export type PiAgentState = "queued" | "running" | "retry" | "done" | "failed";

/** Runtime disponibili per avviare un'istanza. */
export type PiRuntime = "pi" | "opencode";

/** Configurazione di un singolo agente. */
export interface PiAgentConfig {
	/** Prompt/query da inviare all'agente. */
	prompt: string;
	/**
	 * Runtime da usare: `"pi"` (default, `pi -p <QUERY>`) oppure `"opencode"`
	 * (`opencode run "<QUERY>"`). Se non specificato usa `pi`.
	 */
	runtime?: PiRuntime;
	/** Modello specifico (solo runtime `pi`, flag `--model <MODEL>`). */
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

/** Risultato di un'istanza agente al termine dell'esecuzione. */
export interface PiAgentResult {
	id: string;
	label: string;
	runtime: PiRuntime;
	/** Output pulito (ANSI/markdown rimossi). */
	output: string;
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
	/** Nome del binario (es. "pi", "opencode"). */
	bin: string;
	/** Costruisce gli argomenti per `pi.exec(bin, args)`. */
	buildArgs(prompt: string, cfg: PiAgentConfig): string[];
}
