// Widget con barre di progressione per le istanze agente, in stile htop.
// NOTA: `pi -p` e `opencode run` sono processi a "scatola nera": non esiste un
// segnale reale di avanzamento in %. La barra del singolo agente viene quindi
// *stimata* dal tempo trascorso rispetto alla durata media dei job completati.
import type { ExtensionUIContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { PiAgentMeta, PiAgentState, PiRuntime } from "./types.ts";
import { fmtClock, fmtSec, padEndAnsi, padStartAnsi, truncateAnsi, visibleLen } from "./utils.ts";

type WidgetUI = Pick<ExtensionUIContext, "setWidget" | "setStatus">;

/** Struttura minima del TUI richiesta per il widget factory. */
interface TrackerTui {
	requestRender(force?: boolean): void;
}

interface TrackerWidget {
	render(width: number): string[];
	invalidate(): void;
}

const REFRESH_MS = 250;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_ROWS = 8;
const MINI_BAR_W = 10;
/** Larghezza minima della colonna label (la riga può sfondare sotto questa). */
const MIN_LABEL_W = 8;
/** Caratteri minimi di anteprima prompt sotto i quali non viene mostrata. */
const PROMPT_MIN = 14;
/** Soglie di larghezza per la degradazione progressiva della riga agente. */
const W_BAR = 48;
const W_META = 62;
const W_PROMPT = 84;
const DEFAULT_EXPECTED_MS = 60_000;

const STATE_BADGE: Record<PiAgentState, { text: string; color: ThemeColor }> = {
	running: { text: "RUN", color: "accent" },
	retry: { text: "TRY", color: "warning" },
	queued: { text: "QUE", color: "dim" },
	done: { text: "OK ", color: "success" },
	failed: { text: "ERR", color: "error" },
};

interface Task {
	id: string;
	label: string;
	state: PiAgentState;
	runtime?: PiRuntime;
	model?: string;
	prompt?: string;
	startedAt?: number;
	endedAt?: number;
}

interface BarSeg {
	units: number;
	color: ThemeColor;
	anim?: boolean;
}

export interface PiProgressWidgetOptions {
	/** Identificatore del widget (default "pi-agents"). */
	id?: string;
	/** Titolo mostrato nell'header (default "AGENTI"). */
	title?: string;
	/** Sottotitolo mostrato accanto al titolo (default "istanze in parallelo"). */
	subtitle?: string;
	/** Numero massimo di istanze eseguite in parallelo (per il meter LOAD). */
	maxConcurrent?: number;
}

/**
 * Widget reattivo che mostra barre di progressione, tabella degli agenti e
 * status bar. Il widget si attiva al primo `register()` e si rimuove con `stop()`.
 */
export class PiProgressWidget {
	private tasks: Task[] = [];
	private startTime = 0;
	private renderTimer: ReturnType<typeof setInterval> | undefined;
	private ui: WidgetUI;
	private id: string;
	private title: string;
	private subtitle: string;
	private maxConcurrent: number;
	private tui: TrackerTui | undefined;
	private theme: Theme | undefined;

	constructor(ui: WidgetUI, options: PiProgressWidgetOptions = {}) {
		this.ui = ui;
		this.id = options.id ?? "pi-agents";
		this.title = options.title ?? "AGENTI";
		this.subtitle = options.subtitle ?? "istanze in parallelo";
		this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
	}

	private byId(id: string): Task | undefined {
		return this.tasks.find((t) => t.id === id);
	}

	/** Registra un agente (in coda) con metadati opzionali e attiva il widget se ancora inattivo. */
	register(id: string, label: string, meta?: PiAgentMeta): void {
		if (!this.byId(id)) {
			this.tasks.push({
				id,
				label,
				state: "queued",
				runtime: meta?.runtime,
				model: meta?.model,
				prompt: meta?.prompt,
			});
		}
		if (this.renderTimer === undefined) {
			this.startTime = Date.now();
			this.installWidget();
			this.renderTimer = setInterval(() => this.render(), REFRESH_MS);
		}
		this.render();
	}

	/** Aggiorna lo stato di un agente. */
	update(id: string, state: PiAgentState): void {
		const t = this.byId(id);
		if (!t) return;
		t.state = state;
		if (state === "running" && !t.startedAt) t.startedAt = Date.now();
		if (state === "done" || state === "failed") t.endedAt = Date.now();
		this.render();
	}

	/** Svuota tutti gli agenti registrati (usato da PiJob prima di un nuovo run). */
	reset(): void {
		this.tasks = [];
	}

	/** Imposta il limite di concorrenza del meter LOAD (usato da PiJob per sincronizzarlo). */
	setMaxConcurrent(n: number): void {
		this.maxConcurrent = Math.max(1, Math.floor(n) || 1);
		this.render();
	}

	/** Segnala la fine delle esecuzioni (lascia il widget visibile col riepilogo). */
	finish(): void {
		this.render();
	}

	labelOf(id: string): string | undefined {
		return this.byId(id)?.label;
	}

	failedLabels(): string {
		return this.tasks.filter((t) => t.state === "failed").map((t) => t.label).join(", ");
	}

	elapsedMs(): number {
		return this.startTime ? Date.now() - this.startTime : 0;
	}

	counts(): { total: number; done: number; failed: number; running: number } {
		return {
			total: this.tasks.length,
			done: this.tasks.filter((t) => t.state === "done").length,
			failed: this.tasks.filter((t) => t.state === "failed").length,
			running: this.tasks.filter((t) => t.state === "running" || t.state === "retry").length,
		};
	}

	/** Rimuove widget e status bar. */
	stop(): void {
		if (this.renderTimer !== undefined) clearInterval(this.renderTimer);
		this.renderTimer = undefined;
		this.tui = undefined;
		this.theme = undefined;
		this.ui.setWidget(this.id, undefined);
		this.ui.setStatus(this.id, undefined);
	}

	private installWidget(): void {
		this.ui.setWidget(this.id, (tui: TrackerTui, theme: Theme) => {
			this.tui = tui;
			this.theme = theme;
			const widget: TrackerWidget = {
				render: (width: number) => this.renderLines(width),
				invalidate: () => {},
			};
			return widget;
		});
	}

	private render(): void {
		if (this.tui) this.tui.requestRender();
		this.renderStatus();
	}

	// ── dati derivati ──────────────────────────────────────────────────────────

	private avgDoneMs(): number {
		const d = this.tasks
			.filter((t) => t.startedAt && t.endedAt)
			.map((t) => (t.endedAt as number) - (t.startedAt as number));
		return d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0;
	}

	private spinnerFrame(): string {
		return SPINNER_FRAMES[Math.floor(Date.now() / REFRESH_MS) % SPINNER_FRAMES.length] ?? "⠋";
	}

	// ── primitive di rendering ─────────────────────────────────────────────────

	private bar(theme: Theme, width: number, segs: BarSeg[], emptyColor: ThemeColor = "borderMuted"): string {
		const totalUnits = width * 2;
		const cells: (BarSeg | null)[] = new Array(totalUnits).fill(null);
		let pos = 0;
		for (const seg of segs) {
			for (let k = 0; k < seg.units && pos < totalUnits; k++, pos++) cells[pos] = seg;
		}
		const animChar = Math.floor(Date.now() / REFRESH_MS) % 2 === 0 ? "▓" : "█";
		let out = "";
		for (let i = 0; i < totalUnits; i += 2) {
			const a = cells[i] ?? null;
			const b = cells[i + 1] ?? null;
			if (a && b) out += theme.fg(a.color, a.anim || b.anim ? animChar : "█");
			else if (a) out += theme.fg(a.color, "▌");
			else if (b) out += theme.fg(b.color, "▐");
			else out += theme.fg(emptyColor, "░");
		}
		return out;
	}

	private static bucketColor(pct: number): ThemeColor {
		return pct < 70 ? "success" : pct < 100 ? "warning" : "error";
	}

	private miniBar(theme: Theme, pct: number): string {
		const filled = Math.max(0, Math.min(MINI_BAR_W, Math.round((pct / 100) * MINI_BAR_W)));
		return (
			theme.fg("dim", "▐") +
			theme.fg(PiProgressWidget.bucketColor(pct), "█".repeat(filled)) +
			theme.fg("borderMuted", "░".repeat(MINI_BAR_W - filled)) +
			theme.fg("dim", "▌")
		);
	}

	private joinLeftRight(left: string, right: string, w: number): string {
		const leftFixed = truncateAnsi(left, Math.max(1, w - visibleLen(right) - 2));
		const gap = w - visibleLen(leftFixed) - visibleLen(right);
		return leftFixed + (gap > 0 ? " ".repeat(gap) : "") + right;
	}

	private meterLine(theme: Theme, label: string, bar: string, right: string, icon?: string): string {
		const iconPart = icon === undefined ? "" : ` ${theme.fg("dim", icon)}`;
		return `${padEndAnsi(theme.fg("dim", label), 5)}${theme.fg("dim", "[")}${bar}${theme.fg("dim", "]")} ${right}${iconPart}`;
	}

	// ── widget ─────────────────────────────────────────────────────────────────

	private renderLines(width: number): string[] {
		const theme = this.theme;
		if (!theme) return [];
		const w = Math.max(38, width - 2);

		const done = this.tasks.filter((t) => t.state === "done");
		const failed = this.tasks.filter((t) => t.state === "failed");
		const active = this.tasks.filter((t) => t.state === "running" || t.state === "retry");
		const queued = this.tasks.filter((t) => t.state === "queued");
		const total = this.tasks.length;
		const elapsed = this.elapsedMs();

		const lines: string[] = [];

		// Header
		const headLeft =
			theme.bold(theme.fg("accent", "▐▌")) +
			theme.bold(` ${this.title}`) +
			theme.fg("dim", ` · ${this.subtitle}`);
		const headRight = theme.fg("dim", "UPTIME ") + theme.fg("text", fmtClock(elapsed));
		lines.push(` ${this.joinLeftRight(headLeft, headRight, w)}`);

		// Meters
		const meterW = Math.min(30, Math.max(10, w - 24));
		const loadPct = Math.round((active.length / this.maxConcurrent) * 100);
		const loadRight =
			theme.fg("dim", `${active.length}/${this.maxConcurrent}  `) +
			theme.fg(PiProgressWidget.bucketColor(loadPct), padStartAnsi(`${Math.min(999, loadPct)}%`, 4));
		lines.push(
			` ${this.meterLine(theme, "LOAD", this.bar(theme, meterW, [{ units: Math.round((loadPct / 100) * meterW * 2), color: PiProgressWidget.bucketColor(loadPct) }]), loadRight, "⚡")}`,
		);

		const progPct = total ? (done.length / total) * 100 : 0;
		const progUnits = meterW * 2;
		const progSegs: BarSeg[] = [
			{ units: Math.round((done.length / Math.max(1, total)) * progUnits), color: "success" },
			{ units: Math.round((active.length / Math.max(1, total)) * progUnits), color: "accent", anim: true },
			{ units: Math.round((failed.length / Math.max(1, total)) * progUnits), color: "error" },
		];
		const progRight =
			theme.fg("dim", `${done.length}/${total} `) +
			theme.fg("accent", padStartAnsi(`${Math.round(progPct)}%`, 4));
		lines.push(` ${this.meterLine(theme, "PROG", this.bar(theme, meterW, progSegs), progRight, "☉")}`);

		if (failed.length > 0) {
			const failRight = theme.fg("error", `${failed.length} failed`);
			lines.push(
				` ${this.meterLine(theme, "FAIL", this.bar(theme, meterW, [{ units: Math.round((failed.length / Math.max(1, total)) * progUnits), color: "error" }]), failRight)}`,
			);
		}

		// Separatore sezione
		const sepLabel = ` AGENTS · ${queued.length} queued `;
		const sepFill = Math.max(0, w - 4 - sepLabel.length);
		lines.push(` ${theme.fg("borderMuted", `────${sepLabel}${"─".repeat(sepFill)}`)}`);

		// Tabella agenti: attivi + retry + queued + failed
		const rows = [...active, ...queued, ...failed];
		const shown = rows.slice(0, MAX_ROWS);
		const avg = this.avgDoneMs();
		const expected = avg > 0 ? avg : DEFAULT_EXPECTED_MS;
		const withBar = w >= W_BAR;
		const withMeta = w >= W_META;
		const withPrompt = w >= W_PROMPT;

		// Segmenti extra informativi (posizione in coda, eta stimata,
		// runtime·model, retry), in ordine di priorità, mostrati solo se
		// la larghezza lo consente. Calcolati per tutte le righe visibili
		// prima del render: le larghezze di colonna sono uniformi e le righe
		// RUN/QUE restano allineate.
		const rowSegs: { text: string; color: ThemeColor }[][] = shown.map((t) => {
			const segs: { text: string; color: ThemeColor }[] = [];
			if (withMeta) {
				if (t.state === "queued") {
					segs.push({ text: `queue #${queued.indexOf(t) + 1}`, color: "dim" });
				} else if (avg > 0 && t.startedAt && (t.state === "running" || t.state === "retry")) {
					const eta = Math.max(0, expected - (Date.now() - t.startedAt));
					segs.push({ text: `eta~${fmtClock(eta)}`, color: "dim" });
				}
				const rt = t.runtime ?? "agente-ai";
				segs.push({ text: t.model ? `${rt}·${t.model}` : rt, color: "muted" });
				if (t.state === "retry") segs.push({ text: "2/2", color: "warning" });
			}
			return segs;
		});

		// Larghezza visiva degli extra: " " iniziale + testo + " · " tra i
		// segmenti. La colonna usa il massimo tra le righe, con padding.
		const segW = (segs: { text: string }[]) =>
			segs.length ? segs.reduce((a, s) => a + visibleLen(s.text) + 3, -2) : 0;
		const extrasW = rowSegs.reduce((a, s) => Math.max(a, segW(s)), 0);

		// Larghezza fissa della riga senza label né extra: prefisso " NN ▸ "
		// più badge/tempo/simbolo (e blocco barra se presente). Le righe
		// queued usano lo stesso layout (clock di attesa + barra vuota).
		const fixedW = 19 + (withBar ? 20 : 0);

		// Anteprima prompt: colonna con lo stesso cap per tutte le righe,
		// riempie lo spazio residuo, con cap per non schiacciare la label.
		const flatPrompts = shown.map((t) => (t.prompt ? t.prompt.replace(/\s+/g, " ").trim() : ""));
		const promptAvail = w - fixedW - extrasW - MIN_LABEL_W - 3;
		const promptCap = Math.min(Math.max(promptAvail, 0), Math.max(PROMPT_MIN, Math.floor(w * 0.4)));
		const promptOn = withPrompt && flatPrompts.some(Boolean) && promptCap >= PROMPT_MIN;
		const promptW = promptOn ? promptCap + 3 : 0;
		const labelW = Math.max(MIN_LABEL_W, w - fixedW - extrasW - promptW);

		shown.forEach((t, i) => {
			const num = padStartAnsi(String(this.tasks.indexOf(t) + 1), 2, "0");
			const isQueued = t.state === "queued";

			// Colonna extra a larghezza fissa: l'inizio del prompt è allineato.
			const extras = (rowSegs[i] ?? []).map((s) => theme.fg(s.color, s.text)).join(theme.fg("dim", " · "));
			const extrasPart = extrasW > 0 ? padEndAnsi(extras ? ` ${extras}` : "", extrasW) : "";
			const promptText = promptOn ? truncateAnsi(flatPrompts[i] ?? "", promptCap) : "";
			const promptPart = promptText ? ` ${theme.fg("muted", `"${promptText}"`)}` : "";

			const label = padEndAnsi(truncateAnsi(t.label, labelW), labelW);
			const prefix = ` ${theme.fg("dim", num)} ${theme.fg("dim", "▸")} ${label}`;

			const badge = STATE_BADGE[t.state];

			if (isQueued) {
				// Attesa dall'avvio del job, posizione in coda e barra "vuota":
				// stesso layout delle righe attive, con colonne allineate.
				const wait = fmtClock(this.startTime ? Date.now() - this.startTime : 0);
				let qline =
					`${prefix}` +
					` ${theme.fg(badge.color, theme.bold(badge.text))}` +
					` ${theme.fg("dim", padStartAnsi(wait, 6))}` +
					` ${theme.fg("dim", "⏸")}`;
				if (withBar) {
					qline +=
						` ${theme.fg("dim", "▐")}${theme.fg("borderMuted", "▒".repeat(MINI_BAR_W))}${theme.fg("dim", "▌")}` +
						` ${theme.fg("borderMuted", padStartAnsi("--", 4))}` +
						` ${theme.fg("dim", "·")}`;
				}
				lines.push(`${qline}${extrasPart}${promptPart}`);
				return;
			}

			const time = t.startedAt ? fmtClock((t.endedAt ?? Date.now()) - t.startedAt) : "  --  ";
			const sym =
				t.state === "running"
					? theme.fg("accent", this.spinnerFrame())
					: t.state === "retry"
						? theme.fg("warning", this.spinnerFrame())
						: theme.fg("error", "✗");
			let line =
				`${prefix}` +
				` ${theme.fg(badge.color, theme.bold(badge.text))}` +
				` ${theme.fg(t.state === "failed" ? "error" : "text", padStartAnsi(time, 6))}` +
				` ${sym}`;
			if (withBar) {
				if (t.state === "failed") {
					line += " ".repeat(MINI_BAR_W + 10);
				} else {
					const frac = t.startedAt ? Math.min(1, (Date.now() - t.startedAt) / expected) : 0;
					const pct = Math.round(frac * 100);
					const icon = t.state === "running" ? theme.fg("accent", "⚡") : theme.fg("warning", "↻");
					line +=
						` ${this.miniBar(theme, pct)}` +
						` ${theme.fg(PiProgressWidget.bucketColor(pct), padStartAnsi(`${pct}%`, 4))}` +
						` ${icon}`;
				}
			}
			lines.push(`${line}${extrasPart}${promptPart}`);
		});
		if (rows.length > MAX_ROWS) {
			lines.push(` ${theme.fg("dim", `… +${rows.length - MAX_ROWS} agenti`)}`);
		}
		if (rows.length === 0) {
			lines.push(` ${theme.fg("dim", done.length === total ? "tutte le istanze hanno terminato" : "nessuna istanza attiva")}`);
		}

		// Riepilogo completati
		if (done.length > 0) {
			const remaining = total - done.length;
			const eta = avg > 0 ? avg * remaining : 0;
			let summary =
				theme.fg("success", `✔ ${done.length} done`) +
				(avg > 0 ? theme.fg("dim", ` · avg ${fmtSec(avg)}`) : "") +
				(active.length > 0 && eta > 0 ? theme.fg("dim", ` · eta ~${fmtClock(eta)}`) : "");
			const last = done[done.length - 1];
			if (last) {
				summary +=
					theme.fg("muted", " · ") +
					theme.fg("muted", truncateAnsi(last.label, Math.max(8, w - visibleLen(`✔ ${done.length} done · avg ${fmtSec(avg)} · eta ~${fmtClock(eta)} · `))));
			}
			lines.push(` ${truncateAnsi(summary, w)}`);
		}

		return lines;
	}

	// ── status bar ─────────────────────────────────────────────────────────────

	private renderStatus(): void {
		const theme = this.theme;
		const { total, done, failed } = this.counts();
		const retry = this.tasks.filter((t) => t.state === "retry").length;
		const active = this.tasks.filter((t) => t.state === "running").length;
		const elapsed = fmtClock(this.elapsedMs());

		if (!theme) {
			this.ui.setStatus(this.id, `[${done}/${total}] ▶ ${active} ↻ ${retry} ✗ ${failed} · ⏱ ${elapsed}`);
			return;
		}

		const parts = [
			theme.bold(theme.fg("accent", `[${done}/${total}]`)),
			theme.fg("accent", `▶ ${active}`),
			retry > 0 ? theme.fg("warning", `↻ ${retry}`) : "",
			failed > 0 ? theme.fg("error", `✗ ${failed}`) : "",
			theme.fg("dim", `⏱ ${elapsed}`),
		].filter(Boolean);
		this.ui.setStatus(this.id, parts.join(theme.fg("dim", " · ")));
	}
}
