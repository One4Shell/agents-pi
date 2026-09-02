// Utilità generiche per la libreria agenti: gestione codici ANSI,
// formattazione tempi e pulizia dell'output dei modelli.

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/** Rimuove i codici di escape ANSI da una stringa. */
export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** Lunghezza visiva di una stringa (ignora i codici ANSI). */
export function visibleLen(s: string): number {
	return [...s.replace(ANSI_RE, "")].length;
}

/** padEnd consapevole dei codici ANSI. */
export function padEndAnsi(s: string, width: number): string {
	const len = visibleLen(s);
	return len >= width ? s : s + " ".repeat(width - len);
}

/** padStart consapevole dei codici ANSI. */
export function padStartAnsi(s: string, width: number, padChar = " "): string {
	const len = visibleLen(s);
	if (len >= width) return s;
	const fill = padChar.repeat(Math.ceil((width - len) / Math.max(1, [...padChar].length)));
	return fill.slice(0, width - len) + s;
}

/** Tronca una stringa preservando i codici ANSI; aggiunge "…" se troncata. */
export function truncateAnsi(s: string, width: number): string {
	if (width <= 0) return "";
	if (visibleLen(s) <= width) return s;
	const re = new RegExp(ANSI_RE.source, "y");
	let out = "";
	let vis = 0;
	let i = 0;
	while (i < s.length && vis < width - 1) {
		re.lastIndex = i;
		const m = re.exec(s);
		if (m) {
			out += m[0];
			i += m[0].length;
		} else {
			const ch = [...s.slice(i)][0] ?? "";
			out += ch;
			i += ch.length;
			vis++;
		}
	}
	return out + "…";
}

/** Formatta millisecondi come "42s" o "3m05s". */
export function fmtSec(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Formatta millisecondi come orologio "MM:SS". */
export function fmtClock(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const WRAPPING_QUOTES_RE = /^["'«»‹›“”‘’]+|["'«»‹›“”‘’]+$/g;
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g;

/** Rimuove ANSI, blocchi di codice markdown e caratteri di controllo. */
function stripRawOutput(raw: string): string {
	return raw
		.replace(ANSI_RE, "")
		.replace(/```[\s\S]*?```/g, (match) => {
			return match.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "");
		})
		.normalize("NFC")
		.replace(CONTROL_RE, "")
		.replace(SURROGATE_RE, "");
}

/** Pulisce l'output di un agente: prima riga utile, senza formattazione markdown. */
export function cleanModelOutput(raw: string): string {
	if (!raw) return "";
	const firstLine =
		stripRawOutput(raw)
			.split(/\n+/)
			.map((l) => l.trim())
			.filter(Boolean)[0] ?? "";
	return firstLine
		.replace(/[*_~`#]/g, "")
		.replace(WRAPPING_QUOTES_RE, "")
		.trim();
}

/**
 * Tenta di parsare l'output di un agente come JSON valido (solo oggetti `{...}`
 * o array `[...]`, non primitive). Prova prima l'intero output pulito (ANSI e
 * code fence rimossi); se non è JSON, estrae la sottostringa dal primo `{`/`[`
 * all'ultimo `}`/`]` (JSON circondato da altro testo) e riprova.
 * Ritorna il valore parsato oppure `null` se l'output non è JSON valido.
 */
export function parseJsonOutput(raw: string): object | unknown[] | null {
	if (!raw) return null;
	const cleaned = stripRawOutput(raw).trim();
	const accept = (candidate: string): object | unknown[] | null => {
		if (!candidate.trim()) return null;
		try {
			const value: unknown = JSON.parse(candidate);
			return typeof value === "object" && value !== null ? (value as object | unknown[]) : null;
		} catch {
			return null;
		}
	};
	const whole = accept(cleaned);
	if (whole) return whole;
	const starts = [cleaned.indexOf("{"), cleaned.indexOf("[")].filter((i) => i >= 0);
	const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
	if (starts.length === 0 || end < 0 || end <= Math.min(...starts)) return null;
	return accept(cleaned.slice(Math.min(...starts), end + 1));
}

/** Pulisce l'output preservando i paragrafi (per esiti lunghi/multilinea). */
export function cleanMultilineOutput(raw: string): string {
	if (!raw) return "";
	return stripRawOutput(raw)
		.split(/\n/)
		.map((line) =>
			line
				.replace(/[*_~`#]/g, "")
				.replace(/^\s*[-–—]\s+/, "")
				.replace(/^\s*\d+[\.\)]\s+/, "")
				.trim()
		)
		.filter(Boolean)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.replace(WRAPPING_QUOTES_RE, "")
		.trim();
}
