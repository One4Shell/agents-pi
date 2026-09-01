# agents — libreria per istanze di agente in parallelo

Libreria riutilizzabile (estensione per **pi coding agent**) che avvia più istanze
di agente (`pi` / `opencode`) tramite CLI, singolarmente o in parallelo, con un
widget di progresso a barre in stile htop.

Espone le classi `PiAgent`, `PiJob` e `PiProgressWidget`, insieme a runtime e
utilità di supporto, importabili da altre estensioni o usate nei tuoi flussi di
comando/evento. Registra inoltre il tool **`agents_run`**, richiamabile
direttamente dal modello (vedi "Tool per il modello").

## Tool per il modello (`agents_run`)

Oltre al comando demo, l'estensione registra un custom tool via
`pi.registerTool()`: il modello può così lanciare istanze agente da solo,
senza passare da un comando. Definito in `tool.ts`.

### Parametri

| Campo           | Tipo      | Descrizione                                                       |
|-----------------|-----------|-------------------------------------------------------------------|
| `tasks`         | `array`   | 1–8 task `{ label?, prompt, runtime?, model? }`.                   |
| `maxConcurrent` | `integer` | Max istanze parallele, 1–4 (default 1).                            |

Esempio di chiamata che il modello può fare:

```json
{
  "tasks": [
    { "label": "analisi", "prompt": "spiega il file X" },
    { "label": "traduci", "prompt": "traduci Y", "runtime": "opencode" }
  ],
  "maxConcurrent": 2
}
```

### Comportamento

- Esegue i task con un `PiJob`; ogni task è un processo isolato.
- In modalità TUI mostra il `PiProgressWidget` (barre htop) durante l'esecuzione;
  in modalità `rpc`/`json`/`print` usa solo gli aggiornamenti testuali.
- Progressi in streaming al modello via `onUpdate` ("2/5 finished, 1 running…").
- La cancellazione (Esc) è propagata: `PiAgent.run(signal?)` e
  `PiJob.runAll(signal?)` accettano un `AbortSignal` passato a `pi.exec`.
- **Mai lancia**: i task falliti compaiono nel testo restituito come
  `### [label] failed` con l'errore; gli output riusciti sono puliti
  (`cleanMultilineOutput`) e troncati a 4 KB per task (con avviso).
- Il testo finale riporta l'header `N/M succeeded · K failed · <tempo>`.
- Rendering compatto in stile subagent: `✓/✗/⏳` per task, durata, espansione
  con Ctrl+O.

## Comando demo

`index.ts` registra il comando `/demo-agent`. Chiede un prompt all'utente, lancia
3 istanze di `pi` in parallelo e mostra:

- notifiche di riepilogo (`N ok · M errore in <tempo>`);
- l'anteprima dell'output di ogni istanza;
- un widget finale `demo output` con i risultati.

## Posizionamento / installazione

Copiare questa cartella (`agents/`) in una posizione a scoperta automatica delle
estensioni:

```
~/.pi/agent/extensions/agents/
```

e ricaricare con `/reload`.

La libreria usa solo i **tipi** di `@earendil-works/pi-coding-agent` (import
`type`), quindi non richiede installazione di runtime aggiuntivi: si appoggia ai
binari `pi` e `opencode` presenti nel PATH.

## Quick start

```ts
// Dentro eventi/comandi di un'estensione
import { PiAgent, PiJob, PiProgressWidget } from "./index.ts";

const widget = new PiProgressWidget(ctx.ui, { maxConcurrent: 4 });

const job = new PiJob(pi, [
  { id: "a1", label: "analisi", config: { prompt: "spiega il file X" } },
  { id: "a2", label: "traduci", config: { prompt: "traduci Y", runtime: "opencode" } },
], { maxConcurrent: 2, widget });

const results = await job.runAll();
widget.stop();
```

## API di riferimento

### Tipi

#### `PiAgentState`
```ts
"queued" | "running" | "retry" | "done" | "failed"
```

#### `PiRuntime`
```ts
"pi" | "opencode"
```

#### `PiAgentConfig`
| Campo        | Tipo      | Descrizione                                            |
|--------------|-----------|--------------------------------------------------------|
| `prompt`     | `string`  | Prompt/query da inviare all'agente.                    |
| `runtime`    | `PiRuntime` | Runtime da usare (default `"pi"`).                   |
| `model`      | `string`  | Modello specifico (solo runtime `pi`, flag `--model`). |
| `extraArgs`  | `string[]`| Argomenti aggiuntivi da accodare al comando.           |

#### `PiJobSpec`
```ts
{ id: string; label: string; config: PiAgentConfig }
```

#### `PiAgentResult`
| Campo        | Tipo          | Descrizione                                       |
|--------------|---------------|---------------------------------------------------|
| `id`         | `string`      |                                                   |
| `label`      | `string`      |                                                   |
| `runtime`    | `PiRuntime`   |                                                   |
| `output`     | `string`      | Output pulito (ANSI/markdown rimossi).            |
| `rawOutput`  | `string`      | Uscita grezza dal processo.                       |
| `exitCode`   | `number`      |                                                   |
| `state`      | `PiAgentState`|                                                   |
| `durationMs` | `number`      | Durata effettiva in ms (opzionale).               |
| `error`      | `string`      | Presente solo se l'istanza è fallita.             |

#### `AgentRuntime`
```ts
{ type: PiRuntime; bin: string; buildArgs(prompt: string, cfg: PiAgentConfig): string[] }
```

### Classi

#### `PiAgent`
Singola istanza di un agente (`pi` / `opencode`). Esegue il processo in modo
isolato e restituisce il risultato pulito.

- `run(signal?): Promise<PiAgentResult>` — esegue l'istanza e attende il risultato.
  **Non lancia mai**: con exit code ≠ 0 o output vuoto (dopo un retry) restituisce
  un risultato con `state: "failed"` ed `error` valorizzato. Ritenta fino a 2
  volte se il processo esce con codice 0 ma output vuoto. Con `signal` abortito
  termina il processo e riporta `error: "Annullato"` (nessun retry).
- `onState(listener): () => void` — registra un callback di cambio stato; restituisce
  una funzione per rimuoverlo.
- `getState(): PiAgentState` — stato corrente.

#### `PiJob`
Gestisce un insieme di agenti da eseguire in parallelo con un **semaforo di
concorrenza**.

- `constructor(pi, specs, options?)` — `options.maxConcurrent` (default `1`) e
  `options.widget` (opzionale).
- `runAll(signal?): Promise<PiAgentResult[]>` — esegue tutti gli agenti rispettando
  `maxConcurrent`, propagando l'eventuale `signal` alle istanze. **Non lancia
  mai**: gli agenti falliti riportano `state: "failed"`. Risolve con i risultati
  di tutte le istanze.
- `getAgents(): PiAgent[]` — le istanze create.
- `elapsedMs(): number` — millisecondi trascorsi dall'avvio.

#### `PiProgressWidget`
Widget reattivo con barre di progressione, tabella agenti e status bar (stile
htop). Si attiva al primo `register()` e si rimuove con `stop()`.

- `register(id, label)` — registra un agente (in coda) e attiva il widget.
- `update(id, state)` — aggiorna lo stato di un agente.
- `reset()` — svuota gli agenti registrati.
- `finish()` — segnala la fine (lascia il widget col riepilogo).
- `stop()` — rimuove widget e status bar.
- `counts()` — `{ total, done, failed, running }`.
- `failedLabels(): string` — etichette degli agenti falliti, separate da ", ".
- `elapsedMs(): number`.

**Nota sul progresso:** `pi -p` e `opencode run` sono processi a "scatola nera":
non esiste un segnale reale di avanzamento in %. La barra del singolo agente è
quindi *stimata* dal tempo trascorso rispetto alla durata media dei job completati.

Opzioni del costruttore (`PiProgressWidgetOptions`):

| Opzione         | Default        | Descrizione                                    |
|-----------------|----------------|------------------------------------------------|
| `id`            | `"pi-agents"`  | Identificatore del widget.                     |
| `title`         | `"AGENTI"`     | Titolo nell'header.                            |
| `subtitle`      | `"istanze in parallelo"` | Sottotitolo accanto al titolo.       |
| `maxConcurrent` | `1`            | Max istanze parallele (per il meter LOAD).     |

### Runtime

Definiti in `runtimes.ts`; `resolveRuntime(runtime?)` recupera il runtime con
fallback su `pi` (valore predefinito).

| Runtime    | Comando generato                     | Note                                   |
|------------|--------------------------------------|----------------------------------------|
| `pi`       | `pi -p <QUERY> [--model <M>] [extra]`| Predefinito.                           |
| `opencode` | `opencode run "<QUERY>" [extra]`     | Query racchiuso tra virgolette.        |

### Utilità

Esposte da `utils.ts`:

- `stripAnsi(s)` — rimuove i codici di escape ANSI.
- `visibleLen(s)` — lunghezza visiva (ignora gli ANSI).
- `padEndAnsi(s, width)` / `padStartAnsi(s, width, padChar?)` — padding consapevole
  dei codici ANSI.
- `truncateAnsi(s, width)` — tronca preservando gli ANSI; aggiunge "…".
- `fmtSec(ms)` — formatta in `"42s"` o `"3m05s"`.
- `fmtClock(ms)` — formatta come orologio `"MM:SS"`.
- `cleanModelOutput(raw)` — prima riga utile, senza formattazione markdown.
- `cleanMultilineOutput(raw)` — output pulito preservando i paragrafi.

## Esempio esteso

Job con runtime misti e gestione dei risultati:

```ts
import { PiJob, PiProgressWidget } from "./index.ts";
import { fmtSec } from "./utils.ts";

const widget = new PiProgressWidget(ctx.ui, { maxConcurrent: 3, title: "AGENTI" });
const job = new PiJob(pi, [
  { id: "a1", label: "analisi",  config: { prompt: "spiega il file X" } },
  { id: "a2", label: "traduci",  config: { prompt: "traduci Y", runtime: "opencode" } },
  { id: "a3", label: "riassumi", config: { prompt: "riassumi Z", runtime: "pi" } },
], { maxConcurrent: 3, widget });

try {
  const results = await job.runAll();
  const done = results.filter((r) => r.state === "done").length;
  const failed = results.length - done;
  ctx.ui.notify(`${done} ok · ${failed} errore in ${fmtSec(job.elapsedMs())}`,
    failed > 0 ? "warning" : "info");
  for (const r of results) {
    ctx.ui.notify(`[${r.label}] ${r.output.slice(0, 120)}`,
      r.state === "done" ? "info" : "error");
  }
} finally {
  widget.stop();
}
```

## Re-exports

`index.ts` espone:

- Classi: `PiAgent`, `PiJob`, `PiProgressWidget`.
- Tipi: `PiAgentConfig`, `PiAgentResult`, `PiAgentState`, `PiAgentStateListener`,
  `PiJobSpec`, `PiJobOptions`, `PiProgressWidgetOptions`, `PiRuntime`.
- Runtime: `piRuntime`, `opencodeRuntime`, `runtimes`, `resolveRuntime`, `AgentRuntime`.
- Utilità: `stripAnsi`, `cleanModelOutput`, `cleanMultilineOutput`, `fmtSec`,
  `fmtClock`.

Da `tool.ts` sono importabili anche `registerAgentsTool(pi)` (registrazione del
tool, già chiamata da `index.ts`) e il tipo `AgentsRunDetails`.

## Note sul comportamento

- **Mai lancia:** `run()` e `runAll()` non propagano eccezioni; i fallimenti sono
  rappresentati come risultati con `state: "failed"` ed `error` valorizzato.
- L'output dei risultati è pulito da ANSI, blocchi di codice markdown e caratteri
  di controllo.
- La barra del singolo agente è stimata (vedi `PiProgressWidget`).
- `run(signal?)` / `runAll(signal?)` accettano un `AbortSignal` opzionale
  (backward-compatible): all'abort il processo viene terminato e l'istanza
  riporta `error: "Annullato"` senza retry.
