import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiJob } from "./PiJob.ts";
import { PiProgressWidget } from "./PiProgressWidget.ts";
import { fmtSec } from "./utils.ts";

// Libreria riutilizzabile per avviare istanze di "pi coding agent" (e runtime
// alternativi come opencode) tramite la CLI, singolarmente o in parallelo,
// con un widget di progresso a barre.
//
// Uso rapido (dentro eventi/comandi di un'estensione):
//   import { PiAgent, PiJob, PiProgressWidget } from "./index.ts";
//   const widget = new PiProgressWidget(ctx.ui, { maxConcurrent: 4 });
//   const job = new PiJob(pi, [
//     { id: "a1", label: "analisi", config: { prompt: "spiega il file X" } },
//     { id: "a2", label: "traduci", config: { prompt: "traduci Y", runtime: "opencode" } },
//   ], { maxConcurrent: 2, widget });
//   const results = await job.runAll();
//   widget.stop();

export default function (pi: ExtensionAPI) {
	// Comando demo: avvia alcune istanze di agente (pi/opencode) in parallelo.
	// La libreria espone anche le classi riutilizzabili (importabili da altre
	// estensioni o usate nei tuoi flussi).
	pi.registerCommand("demo-agent", {
        description: "esempio comando demo",
        handler: async (_args, ctx) => {
			const prompt = await ctx.ui.input("Richiesta per l'agente: spiega cos'è questo comando");
			if (!prompt) return;

			const widget = new PiProgressWidget(ctx.ui, { maxConcurrent: 2, title: "DEMO", subtitle: "istanze demo" });
			const job = new PiJob(pi, [
				{ id: "a1", label: "analisi", config: { prompt, runtime: "pi" } },
				{ id: "a2", label: "traduci", config: { prompt, runtime: "pi" } },
				{ id: "a3", label: "altra-task", config: { prompt, runtime: "pi" } }, //runtime: "opencode",
			], { maxConcurrent: 3, widget });

			try {
				const results = await job.runAll();
				const done = results.filter((r) => r.state === "done").length;
				const failed = results.length - done;
				ctx.ui.notify(
					`[V] demo completata: ${done} ok · ${failed} errore in ${fmtSec(job.elapsedMs())}`,
					failed > 0 ? "warning" : "info",
				);
				for (const r of results) {
					ctx.ui.notify(`[${r.label}] ${r.output.slice(0, 120)}`, r.state === "done" ? "info" : "error");
				}

				ctx.ui.setWidget("demo output", [
					`--- Output demo-agent (${results.length} istanze) ---`,
					...results.map((r) => `[${r.state}] ${r.label}: ${r.output.slice(0, 120)}`),
				]);
				
			} catch (err: any) {
				ctx.ui.notify(`[!] Errore: ${err?.message || err}`, "error");
			} finally {
				widget.stop();
			}
        },
    });
}

// ── Re-export della libreria ────────────────────────────────────────────────
export { PiAgent } from "./PiAgent.ts";
export type { PiAgentStateListener } from "./PiAgent.ts";

export { PiJob } from "./PiJob.ts";
export type { PiJobOptions } from "./PiJob.ts";

export { PiProgressWidget } from "./PiProgressWidget.ts";
export type { PiProgressWidgetOptions } from "./PiProgressWidget.ts";

export { piRuntime, opencodeRuntime, runtimes, resolveRuntime } from "./runtimes.ts";
export type { AgentRuntime, PiAgentConfig, PiAgentResult, PiAgentState, PiJobSpec, PiRuntime } from "./types.ts";

// ── Utilità di supporto ─────────────────────────────────────────────────────
export { stripAnsi, cleanModelOutput, cleanMultilineOutput, fmtSec, fmtClock } from "./utils.ts";