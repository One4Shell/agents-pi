// Tool LLM-callable "agents_run": rende la libreria utilizzabile dal modello.
// Il modello può chiedere l'esecuzione di 1..8 istanze agente (pi/opencode),
// in parallelo secondo `maxConcurrent`, con progressi in streaming (onUpdate),
// widget htop (solo TUI), cancellazione via signal e output pulito per task.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PiJob } from "./PiJob.ts";
import { PiProgressWidget } from "./PiProgressWidget.ts";
import type { PiAgentResult } from "./types.ts";
import { cleanMultilineOutput, fmtSec } from "./utils.ts";

/** Limiti di sicurezza del tool. */
const MAX_TASKS = 8;
const MAX_CONCURRENT = 4;
/** Cap caratteri per l'output di un task nel testo restituito al modello. */
const PER_TASK_OUTPUT_CAP = 4000;

/** Dettagli del risultato del tool (usati anche dal rendering). */
export interface AgentsRunDetails {
	/** True se l'esecuzione è stata annullata (signal abortito). */
	cancelled: boolean;
	/** Durata totale del job in ms. */
	elapsedMs: number;
	/** Risultati per task: `exitCode === -1` indica un task ancora in corsa. */
	results: PiAgentResult[];
}

const TaskItem = Type.Object({
	label: Type.Optional(Type.String({ description: "Short task name shown in progress and results" })),
	prompt: Type.String({ description: "Prompt/query to send to this agent instance" }),
	runtime: Type.Optional(
		StringEnum(["pi", "opencode"] as const, { description: 'CLI runtime for this task (default "pi")' }),
	),
	model: Type.Optional(Type.String({ description: "Specific model (pi runtime only, --model flag)" })),
});

const AgentsRunParams = Type.Object({
	tasks: Type.Array(TaskItem, {
		minItems: 1,
		maxItems: MAX_TASKS,
		description: `Agent tasks to execute (1-${MAX_TASKS}), in parallel according to maxConcurrent`,
	}),
	maxConcurrent: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_CONCURRENT,
			description: `Max instances running at once (default 1, max ${MAX_CONCURRENT})`,
		}),
	),
});

function truncateText(s: string, cap: number): string {
	if (s.length <= cap) return s;
	return `${s.slice(0, cap)}\n\n[Output truncated: ${s.length - cap} characters omitted]`;
}

function isRunningState(state: PiAgentResult["state"]): boolean {
	return state === "queued" || state === "running" || state === "retry";
}

/** Testo di output di un task: il JSON serializzato se valido, altrimenti pulito. */
function taskOutputText(r: PiAgentResult): string {
	if (r.json !== undefined) return JSON.stringify(r.json, null, 2);
	return cleanMultilineOutput(r.rawOutput || r.output).trim();
}

/** Foto corrente del job come dettagli (per gli update parziali). */
function snapshotDetails(job: PiJob, results: PiAgentResult[] | null, cancelled: boolean): AgentsRunDetails {
	if (results) return { cancelled, elapsedMs: job.elapsedMs(), results };
	return {
		cancelled,
		elapsedMs: job.elapsedMs(),
		results: job.getAgents().map((a) => ({
			id: a.id,
			label: a.label,
			runtime: a.runtime,
			output: "",
			rawOutput: "",
			exitCode: -1,
			state: a.getState(),
		})),
	};
}

function progressText(results: PiAgentResult[]): string {
	const done = results.filter((r) => r.state === "done").length;
	const failed = results.filter((r) => r.state === "failed").length;
	const running = results.length - done - failed;
	return `${done + failed}/${results.length} finished, ${running} running...`;
}

/** Registra il tool `agents_run` sull'ExtensionAPI. */
export function registerAgentsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "agents_run",
		label: "Agents run",
		description:
			"Run one or more agent instances with isolated context via the pi or opencode CLI. " +
			"Each task runs its own process with the given prompt; tasks execute in parallel limited by maxConcurrent. " +
			`Returns the cleaned output of every task. Max ${MAX_TASKS} tasks, max ${MAX_CONCURRENT} concurrent. ` +
			"Use it to parallelize independent queries, delegate isolated subtasks, or compare multiple answers.",
		promptSnippet: "Run one or more agent instances (pi/opencode CLI) with isolated contexts, in parallel or one at a time",
		promptGuidelines: [
			"Use agents_run when several independent agent queries can run at once, instead of issuing them one by one.",
		],
		parameters: AgentsRunParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Cancelled" }],
					details: { cancelled: true, elapsedMs: 0, results: [] } satisfies AgentsRunDetails,
				};
			}

			const specs = params.tasks.map((t, i) => ({
				id: `t${i + 1}`,
				label: (t.label ?? "").trim() || `task ${i + 1}`,
				config: { prompt: t.prompt, runtime: t.runtime, model: t.model },
			}));
			const maxConcurrent = Math.max(1, Math.min(MAX_CONCURRENT, params.maxConcurrent ?? 1));

			// Il widget usa una factory TUI: solo in modalità interattiva.
			const widget =
				ctx.mode === "tui"
					? new PiProgressWidget(ctx.ui, { maxConcurrent, title: "AGENTS", subtitle: "agents_run" })
					: undefined;

			const job = new PiJob(pi, specs, { maxConcurrent, widget });
			const runPromise = job.runAll(signal);

			// runAll() popola gli agenti in modo sincrono prima del primo await:
			// possiamo agganciare subito i listener di progresso.
			const emitUpdate = (): void => {
				if (!onUpdate) return;
				const details = snapshotDetails(job, null, false);
				onUpdate({
					content: [{ type: "text", text: progressText(details.results) }],
					details,
				});
			};
			for (const agent of job.getAgents()) agent.onState(emitUpdate);
			emitUpdate();

			let results: PiAgentResult[];
			try {
				results = await runPromise;
			} finally {
				widget?.stop();
			}

			const cancelled = Boolean(signal?.aborted);
			const done = results.filter((r) => r.state === "done").length;
			const failed = results.length - done;
			const elapsed = fmtSec(job.elapsedMs());
			const header = cancelled
				? `Cancelled — ${done}/${results.length} succeeded before abort`
				: `${done}/${results.length} succeeded · ${failed} failed · ${elapsed}`;

			const sections = results.map((r) => {
				const duration = r.durationMs ? ` (${fmtSec(r.durationMs)})` : "";
				if (r.state === "done") {
					const out = taskOutputText(r);
					return `### [${r.label}] ok${duration}\n${truncateText(out || "(no output)", PER_TASK_OUTPUT_CAP)}`;
				}
				return `### [${r.label}] failed${duration}\nError: ${r.error ?? `exit ${r.exitCode}`}`;
			});

			return {
				content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n---\n\n")}` }],
				details: { cancelled, elapsedMs: job.elapsedMs(), results } satisfies AgentsRunDetails,
			};
		},

		renderCall(args, theme) {
			const tasks = args.tasks ?? [];
			let text =
				theme.fg("toolTitle", theme.bold("agents_run ")) +
				theme.fg("accent", `${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
			for (const t of tasks.slice(0, 3)) {
				const name = t.label?.trim() || (t.prompt.length > 40 ? `${t.prompt.slice(0, 40)}...` : t.prompt);
				text += `\n  ${theme.fg("accent", name)} ${theme.fg("dim", `[${t.runtime ?? "pi"}]`)}`;
			}
			if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as AgentsRunDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const running = details.results.filter((r) => isRunningState(r.state)).length;
			const done = details.results.filter((r) => r.state === "done").length;
			const failedCount = details.results.length - done - running;
			const icon = running > 0 ? theme.fg("warning", "⏸") : failedCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
			const status = details.cancelled
				? `cancelled, ${done}/${details.results.length} succeeded`
				: running > 0
					? `${done + failedCount}/${details.results.length} finished, ${running} running`
					: `${done}/${details.results.length} tasks · ${fmtSec(details.elapsedMs)}`;

			let text = `${icon} ${theme.fg("toolTitle", theme.bold("agents_run "))}${theme.fg("accent", status)}`;
			for (const r of details.results) {
				const rIcon = isRunningState(r.state)
					? theme.fg("warning", "⏸")
					: r.state === "done"
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");
				const duration = r.durationMs ? theme.fg("dim", ` ${fmtSec(r.durationMs)}`) : "";
				text += `\n  ${rIcon} ${theme.fg("accent", r.label)}${theme.fg("muted", ` [${r.runtime}]`)}${duration}`;
				if (expanded) {
					const out = taskOutputText(r);
					const body = r.state === "done" ? out || "(no output)" : `Error: ${r.error ?? `exit ${r.exitCode}`}`;
					for (const line of body.split("\n").slice(0, 10)) text += `\n    ${theme.fg("toolOutput", line)}`;
					if (body.split("\n").length > 10) text += `\n    ${theme.fg("muted", "...")}`;
				} else if (r.state === "failed" && r.error) {
					text += `\n    ${theme.fg("error", `Error: ${r.error}`)}`;
				}
			}
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
