#!/usr/bin/env bash
#
# oai-client.sh - Client CLI stateless per API compatibili OpenAI
#
# Supporta OpenAI, Ollama, LM Studio, vLLM e qualsiasi server che esponga
# l'endpoint /chat/completions in stile OpenAI.
#
# Uso:
#   ./oai-client.sh [opzioni] "prompt"
#   echo "prompt" | ./oai-client.sh [opzioni]
#
set -uo pipefail
# Nota: non usiamo 'set -e' perché vogliamo gestire noi gli errori di curl/jq
# con messaggi diagnostici puliti, invece di uscire silenziosamente.

# ----------------------------------------------------------------------------
# Valori di default (sovrascrivibili da variabili d'ambiente o flag CLI)
# ----------------------------------------------------------------------------
MODEL="${OPENAI_MODEL:-auto}"
BASE_URL="${OPENAI_BASE_URL:-http://192.168.8.217:1337/v1}"
API_KEY="${OPENAI_API_KEY:-password}"
SYSTEM_PROMPT=""
STREAM=false
PROMPT=""
DEBUG="${OPENAI_DEBUG:-false}"    # se true, stampa su stderr i dettagli diagnostici

# Parametri opzionali di generazione (vuoti = non inviati nel payload)
TEMPERATURE="0.1"
TOP_P=""
MAX_TOKENS=""
CONTEXT_WINDOW=""      # mappato su "options.num_ctx" (convenzione Ollama)
REASONING_EFFORT="none"    # mappato su "reasoning_effort" (convenzione OpenAI o-series)

# Parametri extra generici, forma "chiave.puntata=valore", ripetibile
EXTRA_PARAMS=()

# Robustezza della richiesta
RETRIES="${OPENAI_RETRIES:-3}"     # tentativi EXTRA oltre il primo (0 = nessun retry)
TIMEOUT="${OPENAI_TIMEOUT:-800}"      # timeout totale in secondi (curl --max-time); vuoto = nessun limite
BACKOFF_DELAY="${OPENAI_BACKOFF_DELAY:-3}"  # secondi di attesa base tra un tentativo e il successivo

# Modalità "race" (opzionale, disattivata di default): lancia più richieste
# identiche e concorrenti sullo stesso endpoint, sfalsate di pochi ms; la prima
# che risponde con un contenuto valido vince e le altre vengono interrotte.
RACE_COUNT=1                            # 1 = disattivata; >1 = richieste concorrenti
RACE_PARALLEL_DEFAULT="${OPENAI_RACE_PARALLEL:-3}"  # default con --race senza valore
RACE_DELAY_MS="${OPENAI_RACE_DELAY_MS:-50}"         # pausa tra i lanci (millisecondi)

SCRIPT_NAME="$(basename "$0")"

# ----------------------------------------------------------------------------
# Funzione di help
# ----------------------------------------------------------------------------
usage() {
    cat <<EOF
Uso: ${SCRIPT_NAME} [opzioni] ["prompt"]

Client CLI stateless per interagire con qualsiasi server di inferenza
compatibile con le API di OpenAI (OpenAI, Ollama, LM Studio, vLLM, ecc.).

Opzioni di connessione:
  -m, --model <nome>       Modello da usare (default: \$OPENAI_MODEL o "gpt-4o-mini")
  -u, --url <endpoint>     Base URL delle API (default: \$OPENAI_BASE_URL o "https://api.openai.com/v1")
  -k, --key <chiave>       API key (default: \$OPENAI_API_KEY)
  -s, --system <testo>     System prompt opzionale
      --stream              Abilita lo streaming della risposta in tempo reale
  -r, --retries <n>         Numero di tentativi extra in caso di timeout/errore
                             transitorio (default: \$OPENAI_RETRIES o 0 = nessun retry).
                             Gli errori 4xx non vengono ritentati.
      --timeout <secondi>   Timeout totale della richiesta in secondi
                             (default: \$OPENAI_TIMEOUT; vuoto = nessun limite)
      --race [N]            Modalità "race": lancia N richieste identiche e
                             concorrenti sullo stesso endpoint, sfalsate di
                             pochi ms (default: \$OPENAI_RACE_PARALLEL o 5).
                             Vince la prima che risponde con un contenuto
                             valido; le altre vengono fermate. Serve a
                             ridurre i timeout con backend flaky (es. g4f).
                             Non compatibile con --stream.
      --race-delay <ms>     Pausa tra il lancio di ogni richiesta della race
                             (default: \$OPENAI_RACE_DELAY_MS o 20 ms)

Opzioni di generazione:
  -t, --temperature <n>    Temperatura di campionamento (es. 0.7)
      --top-p <n>           Nucleus sampling (es. 0.9)
      --max-tokens <n>      Numero massimo di token generati in output
      --context-window <n>  Dimensione della finestra di contesto.
                             NOTA: convenzione Ollama, viene inviato come
                             "options.num_ctx". Con altri server usa --param.
      --reasoning-effort <low|medium|high|none>
                             Livello di ragionamento (convenzione OpenAI
                             per modelli o-series / reasoning). "none"
                             equivale a disattivarlo dove supportato.
      --no-reasoning         Scorciatoia per --reasoning-effort none
  -p, --param <chiave=val>  Aggiunge/sovrascrive un campo qualsiasi nel body
                             JSON della richiesta. Ripetibile. Supporta chiavi
                             annidate con la notazione punto, es:
                               --param chat_template_kwargs.enable_thinking=false
                             Se il valore è JSON valido (numero, bool, oggetto,
                             array) viene inviato come tale, altrimenti come
                             stringa.

Altro:
  -h, --help                Mostra questo messaggio ed esce
      --debug               Stampa su stderr i dettagli diagnostici (tentativi
                             di retry, risposte grezze, codice HTTP).
                             Di default i retry sono silenziosi e a schermo
                             esce solo la risposta (o l'errore finale).

Input del prompt (uno dei due, non entrambi):
  1) Argomento posizionale:
       ${SCRIPT_NAME} "Ciao, come stai?"
  2) Da STDIN (pipe):
       echo "Riassumi questo testo" | ${SCRIPT_NAME}

Esempi:
  # OpenAI standard, con temperatura e limite di token
  export OPENAI_API_KEY="sk-..."
  ${SCRIPT_NAME} -m gpt-4o -t 0.5 --max-tokens 300 "Spiegami la relatività"

  # Modello reasoning OpenAI, ragionamento disattivato
  ${SCRIPT_NAME} -m o3-mini --no-reasoning "Quanto fa 12*7?"

  # Ollama locale, context window a 8192 token, streaming
  ${SCRIPT_NAME} -u http://localhost:11434/v1 -m llama3 \\
    --context-window 8192 --stream "Scrivi una poesia"

  # vLLM con modello Qwen3, ragionamento disattivato via campo custom
  ${SCRIPT_NAME} -u http://localhost:8000/v1 -m Qwen3-8B \\
    --param chat_template_kwargs.enable_thinking=false "Ciao"

  # Parametro generico arbitrario (es. seed)
  ${SCRIPT_NAME} --param seed=42 "Genera un numero casuale"

EOF
}

# ----------------------------------------------------------------------------
# Controllo dipendenze essenziali
# ----------------------------------------------------------------------------
check_dependencies() {
    local missing=()
    command -v curl >/dev/null 2>&1 || missing+=("curl")
    command -v jq   >/dev/null 2>&1 || missing+=("jq")

    if [ "${#missing[@]}" -gt 0 ]; then
        echo "Errore: dipendenze mancanti: ${missing[*]}" >&2
        echo "Installale con, ad esempio: sudo apt install ${missing[*]}" >&2
        exit 1
    fi
}

# ----------------------------------------------------------------------------
# Validazione numeri interi
# ----------------------------------------------------------------------------
is_nonneg_int() {
    [[ "$1" =~ ^[0-9]+$ ]]
}

# ----------------------------------------------------------------------------
# Stampa su stderr solo se --debug è attivo (messaggi diagnostici di dettaglio)
# ----------------------------------------------------------------------------
dbg() {
    [ "$DEBUG" = true ] && echo "$@" >&2
}

# ----------------------------------------------------------------------------
# Parsing dei flag (supporta sia forma corta -x che lunga --xxx)
# ----------------------------------------------------------------------------
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            -m|--model)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                MODEL="$2"; shift 2 ;;
            -u|--url)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                BASE_URL="${2%/}"; shift 2 ;;   # rimuove eventuale slash finale
            -k|--key)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                API_KEY="$2"; shift 2 ;;
            -s|--system)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                SYSTEM_PROMPT="$2"; shift 2 ;;
            --stream)
                STREAM=true; shift ;;
            --debug)
                DEBUG=true; shift ;;
            -r|--retries)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                is_nonneg_int "$2" || { echo "Errore: '$1' richiede un numero intero (ricevuto: '$2')." >&2; exit 1; }
                RETRIES="$2"; shift 2 ;;
            --timeout)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                is_nonneg_int "$2" || { echo "Errore: '$1' richiede un numero di secondi (ricevuto: '$2')." >&2; exit 1; }
                TIMEOUT="$2"; shift 2 ;;
            --race)
                # Argomento opzionale: "--race" (default) oppure "--race <N>"
                if [ -n "${2:-}" ] && is_nonneg_int "$2"; then
                    RACE_COUNT="$2"; shift 2
                else
                    RACE_COUNT="$RACE_PARALLEL_DEFAULT"; shift
                fi
                if [ "$RACE_COUNT" -lt 1 ]; then
                    echo "Errore: '--race' richiede almeno 1 richiesta (ricevuto: '$RACE_COUNT')." >&2
                    exit 1
                fi ;;
            --race-delay)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                is_nonneg_int "$2" || { echo "Errore: '$1' richiede un numero di millisecondi (ricevuto: '$2')." >&2; exit 1; }
                RACE_DELAY_MS="$2"; shift 2 ;;
            -t|--temperature)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                TEMPERATURE="$2"; shift 2 ;;
            --top-p)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                TOP_P="$2"; shift 2 ;;
            --max-tokens)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                MAX_TOKENS="$2"; shift 2 ;;
            --context-window|--num-ctx)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                CONTEXT_WINDOW="$2"; shift 2 ;;
            --reasoning-effort)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento." >&2; exit 1; }
                REASONING_EFFORT="$2"; shift 2 ;;
            --no-reasoning)
                REASONING_EFFORT="none"; shift ;;
            -p|--param)
                [ -n "${2:-}" ] || { echo "Errore: '$1' richiede un argomento nel formato chiave=valore." >&2; exit 1; }
                if [[ "$2" != *"="* ]]; then
                    echo "Errore: '--param' richiede il formato chiave=valore (ricevuto: '$2')." >&2
                    exit 1
                fi
                EXTRA_PARAMS+=("$2"); shift 2 ;;
            -h|--help)
                usage; exit 0 ;;
            --)
                shift
                if [ $# -gt 0 ]; then PROMPT="$1"; shift; fi
                break ;;
            -*)
                echo "Errore: opzione sconosciuta '$1'" >&2
                usage
                exit 1 ;;
            *)
                # Primo argomento posizionale = prompt
                if [ -z "$PROMPT" ]; then
                    PROMPT="$1"
                else
                    echo "Errore: troppi argomenti posizionali." >&2
                    exit 1
                fi
                shift ;;
        esac
    done
}

# ----------------------------------------------------------------------------
# Determina il prompt: argomento posizionale XOR stdin (pipe)
# ----------------------------------------------------------------------------
resolve_prompt() {
    local has_stdin=false
    if [ -p /dev/stdin ]; then
        has_stdin=true
    fi

    if [ -n "$PROMPT" ] && [ "$has_stdin" = true ]; then
        echo "Errore: fornisci il prompt via argomento OPPURE via pipe, non entrambi." >&2
        exit 1
    fi

    if [ -z "$PROMPT" ] && [ "$has_stdin" = false ]; then
        echo "Errore: nessun prompt fornito." >&2
        echo "Usa: ${SCRIPT_NAME} \"il tuo prompt\"  oppure  echo \"prompt\" | ${SCRIPT_NAME}" >&2
        exit 1
    fi

    if [ "$has_stdin" = true ]; then
        PROMPT="$(cat)"
        if [ -z "$PROMPT" ]; then
            echo "Errore: lo stdin è vuoto." >&2
            exit 1
        fi
    fi
}

# ----------------------------------------------------------------------------
# Imposta un campo (anche annidato, notazione punto) in un JSON esistente.
# Se il valore è JSON valido (numero/bool/oggetto/array) viene usato come
# tale, altrimenti come stringa semplice.
#   $1 = json corrente (stringa)
#   $2 = percorso puntato, es. "options.num_ctx"
#   $3 = valore grezzo
# Stampa il nuovo JSON su stdout.
# ----------------------------------------------------------------------------
set_json_field() {
    local json="$1" path="$2" value="$3"
    local jq_path
    jq_path="$(jq -Rn --arg p "$path" '$p | split(".")')"

    if echo "$value" | jq -e . >/dev/null 2>&1; then
        jq --argjson p "$jq_path" --argjson v "$value" 'setpath($p; $v)' <<<"$json"
    else
        jq --argjson p "$jq_path" --arg v "$value" 'setpath($p; $v)' <<<"$json"
    fi
}

# ----------------------------------------------------------------------------
# Applica tutti i parametri opzionali (dedicati + --param generici) al JSON
# ----------------------------------------------------------------------------
apply_optional_params() {
    local json="$1"

    [ -n "$TEMPERATURE" ]      && json="$(set_json_field "$json" "temperature" "$TEMPERATURE")"
    [ -n "$TOP_P" ]            && json="$(set_json_field "$json" "top_p" "$TOP_P")"
    [ -n "$MAX_TOKENS" ]       && json="$(set_json_field "$json" "max_tokens" "$MAX_TOKENS")"
    [ -n "$CONTEXT_WINDOW" ]   && json="$(set_json_field "$json" "options.num_ctx" "$CONTEXT_WINDOW")"
    [ -n "$REASONING_EFFORT" ] && json="$(set_json_field "$json" "reasoning_effort" "$REASONING_EFFORT")"

    local kv key value
    for kv in "${EXTRA_PARAMS[@]:-}"; do
        [ -z "$kv" ] && continue
        key="${kv%%=*}"
        value="${kv#*=}"
        json="$(set_json_field "$json" "$key" "$value")"
    done

    echo "$json"
}

# ----------------------------------------------------------------------------
# Costruisce il body JSON base della richiesta, poi applica i parametri extra
# ----------------------------------------------------------------------------
build_payload() {
    local stream_flag="$1"
    local base

    if [ -n "$SYSTEM_PROMPT" ]; then
        base="$(jq -n \
            --arg model "$MODEL" \
            --arg sys "$SYSTEM_PROMPT" \
            --arg user "$PROMPT" \
            --argjson stream "$stream_flag" \
            '{
                model: $model,
                stream: $stream,
                messages: [
                    {role: "system", content: $sys},
                    {role: "user", content: $user}
                ]
            }')"
    else
        base="$(jq -n \
            --arg model "$MODEL" \
            --arg user "$PROMPT" \
            --argjson stream "$stream_flag" \
            '{
                model: $model,
                stream: $stream,
                messages: [
                    {role: "user", content: $user}
                ]
            }')"
    fi

    apply_optional_params "$base"
}

# ----------------------------------------------------------------------------
# Decisione retry: stampa un avviso, attende con backoff e ritorna 0 se ci
# sono ancora tentativi disponibili, 1 se sono esauriti.
#   $1 = numero del tentativo appena eseguito (1 = primo)
#   $2 = motivo dell'errore
# ----------------------------------------------------------------------------
retry_wait() {
    local attempt="$1" reason="$2"
    [ "$attempt" -le "$RETRIES" ] || return 1
    local wait_sec=$((BACKOFF_DELAY * attempt))
    dbg "Errore (${reason}): tentativo ${attempt}/$((RETRIES + 1)) non riuscito, riprovo tra ${wait_sec}s."
    sleep "$wait_sec"
    return 0
}

# ----------------------------------------------------------------------------
# Ritorna 0 (vero) se un messaggio d'errore del server indica una condizione
# transitoria (server sovraccarico o rate limit) per cui vale la pena
# ritentare la richiesta; 1 altrimenti.
# ----------------------------------------------------------------------------
is_transient_error() {
    local msg="${1,,}"
    case "$msg" in
        *overload*|*"temporarily unavailable"*|*"rate limit"*|*"too many requests"*|*busy*|*"try again later"*|*capacity*|*unavailable*|*"429"*|*"503"*)
            return 0 ;;
        *)
            return 1 ;;
    esac
}

# ----------------------------------------------------------------------------
# Funzioni della modalità "race": N richieste identiche concorrenti sullo
# stesso endpoint, partenze sfalsate di pochi ms; la prima che risponde con un
# contenuto valido vince e gli altri worker vengono interrotti.
#
# Ogni worker è un subshell in background che esegue curl e, al termine, scrive
# nell'area di lavoro i file: "body" (corpo), "code" (codice HTTP), "err"
# (stderr di curl) e infine "rc" (exit code di curl). La presenza del file "rc"
# segnala che il worker ha finito. Con "set -m" ogni worker ha un proprio
# process group, quindi kill -- -<pid> ferma anche il curl figlio.
# ----------------------------------------------------------------------------

# Stoppa i worker del round corrente e rimuove la directory di lavoro.
# Usata sia alla fine di un round sia in caso di Ctrl-C (trap INT/TERM).
race_cleanup() {
    local pid
    if [ -n "${RACE_PIDS+x}" ] && [ ${#RACE_PIDS[@]} -gt 0 ]; then
        for pid in "${RACE_PIDS[@]}"; do
            if kill -0 "$pid" 2>/dev/null; then
                kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
            fi
        done
    fi
    if [ -n "${RACE_TMPDIR:-}" ] && [ -d "$RACE_TMPDIR" ]; then
        rm -rf "$RACE_TMPDIR"
    fi
}

# Classifica l'esito di un worker già terminato (i file rc/code/body devono
# esistere in $1). Imposta worker_http/worker_msg/worker_body/worker_verdict
# e, in caso di vincitore, race_winner_content.
# worker_verdict: winner | perm | trans | net
# Ritorna 0 se il worker è il vincitore (contenuto valido), 1 altrimenti.
classify_worker_dir() {
    local dir="$1"
    local rc="" http="" body="" emsg=""

    worker_http=""
    worker_msg=""
    worker_body=""
    worker_verdict="net"
    worker_bad2xx=0

    if [ -f "$dir/rc" ]; then
        rc="$(<"$dir/rc")"
    else
        return 1
    fi
    [ -f "$dir/code" ] && http="$(<"$dir/code")"
    [ -f "$dir/body" ] && body="$(<"$dir/body")"
    worker_body="$body"

    if [ -n "$body" ]; then
        emsg="$(printf '%s' "$body" | jq -r '.error.message // empty' 2>/dev/null)"
        worker_msg="$emsg"
    fi

    # Errore di rete / timeout
    if [ -n "$rc" ] && [ "$rc" -ne 0 ]; then
        worker_verdict="net"
        return 1
    fi

    # HTTP 2xx: l'unico caso che può produrre un vincitore
    if [ -n "$http" ] && [ "$http" -ge 200 ] && [ "$http" -lt 300 ]; then
        # Alcuni proxy rispondono 2xx ma con un errore transitorio nel body
        if [ -n "$emsg" ] && is_transient_error "$emsg"; then
            worker_verdict="trans"
            return 1
        fi
        if printf '%s' "$body" | jq -e '.choices[0].message.content' >/dev/null 2>&1; then
            race_winner_content="$(printf '%s' "$body" | jq -r '.choices[0].message.content')"
            worker_verdict="winner"
            return 0
        fi
        # 2xx senza contenuto valido né errore transitorio: non ritentabile
        worker_verdict="perm"
        worker_bad2xx=1
        return 1
    fi

    # HTTP 4xx (tranne 408/429): errore permanente
    if [ -n "$http" ] && [ "$http" -lt 500 ] && [ "$http" -ne 408 ] && [ "$http" -ne 429 ]; then
        worker_verdict="perm"
        return 1
    fi

    # HTTP vuoto, 408, 429 o 5xx: transitorio
    worker_verdict="trans"
    return 1
}

# Esegue un intero "round" di race: lancia RACE_COUNT worker concorrenti e
# attende il primo contenuto valido. In caso di vincitore stampa il contenuto
# su stdout e ritorna 0; altrimenti imposta race_error_* e ritorna 1.
#   $1 = payload JSON della richiesta
parallel_race_round() {
    local payload="$1"
    local delay_s tmpdir wdir pid i
    local -a pids dirs done_map
    local finished winner_found
    local worker_http worker_msg worker_body worker_verdict worker_bad2xx

    race_winner=0
    race_winner_content=""
    race_error_type="net"
    race_error_http=""
    race_error_msg=""
    race_error_body=""
    race_error_bad2xx=0

    # Converti RACE_DELAY_MS (ms) in secondi decimali per sleep
    if [ "$RACE_DELAY_MS" -ge 1000 ]; then
        delay_s="$((RACE_DELAY_MS / 1000)).$(printf '%03d' "$((RACE_DELAY_MS % 1000))")"
    else
        delay_s="0.$(printf '%03d' "$RACE_DELAY_MS")"
    fi

    tmpdir="$(mktemp -d)"
    RACE_TMPDIR="$tmpdir"
    RACE_PIDS=()
    pids=()
    dirs=()

    for ((i=0; i<RACE_COUNT; i++)); do
        wdir="$tmpdir/$i"
        mkdir -p "$wdir"
        (
            curl -sS \
                --connect-timeout 10 \
                ${TIMEOUT:+--max-time "${TIMEOUT}"} \
                -X POST "${BASE_URL}/chat/completions" \
                -H "Content-Type: application/json" \
                ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
                -w '%{http_code}' \
                -o "$wdir/body" \
                -d "$payload" \
                >"$wdir/code" 2>"$wdir/err"
            echo "$?" >"$wdir/rc"
        ) &
        pids+=("$!")
        RACE_PIDS+=("$!")
        dirs+=("$wdir")
        # pausa tra i lanci: "a distanza di pochi ms"
        [ "$((i + 1))" -lt "$RACE_COUNT" ] && sleep "$delay_s"
    done

    done_map=()
    for ((i=0; i<RACE_COUNT; i++)); do done_map[$i]=0; done
    finished=0
    winner_found=false

    while [ "$finished" -lt "$RACE_COUNT" ]; do
        for ((i=0; i<RACE_COUNT; i++)); do
            [ "${done_map[$i]}" = 1 ] && continue
            wdir="${dirs[$i]}"
            if [ ! -f "$wdir/rc" ]; then
                continue
            fi
            # Recupera il figlio terminato (evita zombie) e riusa l'area
            wait "${pids[$i]}" 2>/dev/null || true
            done_map[$i]=1
            finished=$((finished + 1))

            if classify_worker_dir "$wdir"; then
                winner_found=true
                break 2
            fi

            dbg "  worker $((i + 1)): esito=${worker_verdict} http=${worker_http:-n/a} ${worker_msg:+($worker_msg)}"

            # Registra l'errore più significativo per il resoconto del round
            case "$worker_verdict" in
                perm)
                    if [ "$race_error_type" != "perm" ]; then
                        race_error_type="perm"
                        race_error_http="$worker_http"
                        race_error_msg="$worker_msg"
                        race_error_body="$worker_body"
                        race_error_bad2xx="$worker_bad2xx"
                    fi ;;
                trans)
                    [ "$race_error_type" = "net" ] && race_error_type="trans" ;;
            esac
        done
        [ "$winner_found" = true ] && break
        sleep 0.02
    done

    # Interrompi i worker ancora attivi e recuperali
    for pid in "${pids[@]:-}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    for ((i=0; i<RACE_COUNT; i++)); do
        wait "${pids[$i]}" 2>/dev/null || true
    done
    RACE_PIDS=()
    rm -rf "$tmpdir"
    RACE_TMPDIR=""

    if [ "$winner_found" = true ]; then
        race_winner=1
        return 0
    fi
    return 1
}

# Ciclo di tentativi in modalità race: replica la logica retry/backoff della
# modalità singola, ma ogni "tentativo" è un round di RACE_COUNT richieste
# concorrenti. Vince (ed esce) la prima con contenuto valido.
parallel_call_non_streaming() {
    local payload="$1"
    local attempt

    for ((attempt=1; attempt<=RETRIES+1; attempt++)); do
        if parallel_race_round "$payload"; then
            printf '%s\n' "$race_winner_content"
            return 0
        fi

        case "$race_error_type" in
            perm)
                if [ "$race_error_bad2xx" = 1 ]; then
                    echo "Errore: risposta inattesa dal server (formato non riconosciuto)." >&2
                    echo "Risposta grezza: $(printf '%s' "$race_error_body" | head -c 500)" >&2
                else
                    echo "Errore HTTP ${race_error_http:-?} dal server." >&2
                    if [ -n "$race_error_msg" ]; then
                        echo "Messaggio: $race_error_msg" >&2
                    else
                        echo "Risposta grezza: $(printf '%s' "$race_error_body" | head -c 500)" >&2
                    fi
                fi
                exit 1 ;;
            trans)
                if retry_wait "$attempt" "tutte le richieste race in errore transitorio"; then
                    continue
                fi
                echo "Errore: le richieste race ($RACE_COUNT concorrenti) non sono andate a buon fine." >&2
                echo "Raggiunto il numero massimo di tentativi ($((RETRIES + 1)))." >&2
                exit 1 ;;
            net)
                if retry_wait "$attempt" "timeout o errore di rete su tutte le richieste race"; then
                    continue
                fi
                echo "Errore: impossibile contattare l'endpoint '${BASE_URL}' dopo $((RETRIES + 1)) tentativi." >&2
                echo "(Race con $RACE_COUNT richieste concorrenti per tentativo.)" >&2
                exit 1 ;;
        esac
    done
    return 1
}

# ----------------------------------------------------------------------------
# Chiamata non-streaming: cattura la risposta completa e la stampa con jq
# ----------------------------------------------------------------------------
call_non_streaming() {
    local payload response http_code body err_msg
    local attempt curl_exit

    payload="$(build_payload false)"

    # Modalità race: se attiva, l'intero flusso (con retry) è gestito altrove
    if [ "$RACE_COUNT" -gt 1 ]; then
        parallel_call_non_streaming "$payload"
        return
    fi

    for ((attempt=1; attempt<=RETRIES+1; attempt++)); do
        response="$(curl -sS -w '\n%{http_code}' \
            --connect-timeout 10 \
            ${TIMEOUT:+--max-time "${TIMEOUT}"} \
            -X POST "${BASE_URL}/chat/completions" \
            -H "Content-Type: application/json" \
            ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
            -d "$payload" 2>&1)"
        curl_exit=$?

        if [ $curl_exit -ne 0 ]; then
            if retry_wait "$attempt" "timeout o errore di rete"; then
                continue
            fi
            echo "Errore: impossibile contattare l'endpoint '${BASE_URL}' dopo $((RETRIES + 1)) tentativi." >&2
            dbg "Dettaglio curl: $response"
            exit 1
        fi

        http_code="$(echo "$response" | tail -n1)"
        body="$(echo "$response" | sed '$d')"

        if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
            # Alcuni proxy rispondono 2xx ma con un errore nel body
            # (es. "Service temporarily overloaded"): ritenta se transitorio.
            err_msg="$(echo "$body" | jq -r '.error.message // empty' 2>/dev/null)"
            if [ -n "$err_msg" ] && is_transient_error "$err_msg"; then
                if retry_wait "$attempt" "$err_msg"; then
                    continue
                fi
                echo "Errore dal server: $err_msg" >&2
                echo "Raggiunto il numero massimo di tentativi ($((RETRIES + 1)))." >&2
                exit 1
            fi
            break
        fi

        # HTTP 4xx non transitori (es. 400, 401): inutile ritentare
        if [ "$http_code" -lt 500 ] && [ "$http_code" -ne 408 ] && [ "$http_code" -ne 429 ]; then
            echo "Errore HTTP $http_code dal server." >&2
            err_msg="$(echo "$body" | jq -r '.error.message // empty' 2>/dev/null)"
            if [ -n "$err_msg" ]; then
                echo "Messaggio: $err_msg" >&2
            else
                echo "Risposta grezza: $body" >&2
            fi
            exit 1
        fi

        # 408/429/5xx: transitori, ritentabili
        if retry_wait "$attempt" "HTTP $http_code dal server"; then
            continue
        fi

        echo "Errore HTTP $http_code dal server." >&2
        err_msg="$(echo "$body" | jq -r '.error.message // empty' 2>/dev/null)"
        if [ -n "$err_msg" ]; then
            echo "Messaggio: $err_msg" >&2
        else
            echo "Risposta grezza: $body" >&2
        fi
        echo "Raggiunto il numero massimo di tentativi ($((RETRIES + 1)))." >&2
        exit 1
    done

    if ! echo "$body" | jq -e '.choices[0].message.content' >/dev/null 2>&1; then
        echo "Errore: risposta inattesa dal server (formato non riconosciuto)." >&2
        echo "Risposta grezza: $body" >&2
        exit 1
    fi

    echo "$body" | jq -r '.choices[0].message.content'
}

# ----------------------------------------------------------------------------
# Chiamata streaming: legge SSE riga per riga ed estrae i "delta" al volo.
# Il retry è ammesso solo se il tentativo non ha prodotto alcun output
# (per evitare di duplicare testo già stampato) e l'eventuale errore del
# server è transitorio (sovraccarico / rate limit).
# ----------------------------------------------------------------------------
call_streaming() {
    local payload attempt curl_exit cpid
    local fifo done_seen had_output error_seen
    local data err_msg token line http_code plain_body

    payload="$(build_payload true)"

    for ((attempt=1; attempt<=RETRIES+1; attempt++)); do
        had_output=false
        error_seen=false
        done_seen=false
        http_code=""
        plain_body=""

        fifo="$(mktemp -u)"
        mkfifo "$fifo"

        curl -sS -N \
            --connect-timeout 10 \
            ${TIMEOUT:+--max-time "${TIMEOUT}"} \
            -X POST "${BASE_URL}/chat/completions" \
            -H "Content-Type: application/json" \
            -H "Accept: text/event-stream" \
            ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
            -w '\n%{http_code}' \
            -d "$payload" >"$fifo" &
        cpid=$!

        exec 3<"$fifo"
        while IFS= read -r line <&3; do
            # Ultima riga scritta da curl (-w): codice HTTP, es. "402"
            if [[ "$line" =~ ^[0-9]{3}$ ]]; then
                http_code="$line"
                continue
            fi

            # Riga non-SSE: accumulala per diagnosticare errori in body
            # JSON semplice (alcuni server non usano il prefisso "data: ").
            if [[ "$line" != data:\ * ]]; then
                [ -n "$line" ] && plain_body+="$line"$'\n'
                continue
            fi
            data="${line#data: }"

            if [ "$data" = "[DONE]" ]; then
                done_seen=true
                break
            fi

            err_msg="$(echo "$data" | jq -r '.error.message // empty' 2>/dev/null)"
            if [ -n "$err_msg" ]; then
                error_seen=true
                break
            fi

            token="$(echo "$data" | jq -r '.choices[0].delta.content // empty' 2>/dev/null)"
            if [ -n "$token" ]; then
                printf '%s' "$token"
                had_output=true
            fi
        done
        exec 3<&-

        # Se il server ha segnalato [DONE] o un errore ma tiene ancora aperta
        # la connessione, terminiamo curl per non rimanere appesi sul wait.
        if [ "$done_seen" = true ] || [ "$error_seen" = true ]; then
            kill "$cpid" 2>/dev/null || true
        fi
        wait "$cpid"
        curl_exit=$?
        rm -f "$fifo"

        if [ "$error_seen" = true ]; then
            # Errore dopo output parziale: il testo è già stato stampato,
            # ritentare duplicherebbe contenuto, quindi usciamo subito.
            if [ "$had_output" = true ]; then
                echo "" >&2
                echo "Errore dal server durante lo streaming: $err_msg" >&2
                echo "Stream interrotto dopo output parziale: nessun retry per evitare testo duplicato." >&2
                exit 1
            fi

            # Errore transitorio (es. "Service temporarily overloaded"): retry
            if is_transient_error "$err_msg"; then
                if retry_wait "$attempt" "$err_msg"; then
                    continue
                fi
                echo "Errore dal server durante lo streaming: $err_msg" >&2
                echo "Raggiunto il numero massimo di tentativi ($((RETRIES + 1)))." >&2
                exit 1
            fi

            # Errore non transitorio: nessun retry
            echo "Errore dal server durante lo streaming: $err_msg" >&2
            exit 1
        fi

        # Marker [DONE] ricevuto: flusso completato correttamente
        if [ "$done_seen" = true ]; then
            if [ "$had_output" = true ]; then
                break
            fi
            echo "Attenzione: nessun contenuto ricevuto dallo stream." >&2
            exit 1
        fi

        # Nessun [DONE]: flusso interrotto da errore di rete o timeout
        if [ "$curl_exit" -ne 0 ]; then
            if [ "$had_output" = true ]; then
                echo "" >&2
                echo "Errore: connessione allo stream persa dopo output parziale (endpoint '${BASE_URL}')." >&2
                exit 1
            fi
            if retry_wait "$attempt" "timeout o errore di rete durante lo streaming"; then
                continue
            fi
            echo "Errore: connessione allo stream fallita (endpoint '${BASE_URL}') dopo $((RETRIES + 1)) tentativi." >&2
            exit 1
        fi

        # Output già stampato ma stream chiuso senza [DONE]: protocollo
        # incompleto. Ritentare duplicherebbe testo.
        if [ "$had_output" = true ]; then
            echo "" >&2
            echo "Errore: stream chiuso dal server senza marcatore [DONE] dopo output parziale (endpoint '${BASE_URL}')." >&2
            exit 1
        fi

        # Nessun [DONE] né output: la risposta può essere un errore non-SSE,
        # ovvero JSON semplice al posto del flusso di eventi. Estrai il
        # messaggio d'errore dal body accumulato, se presente.
        err_msg=""
        if [ -n "$plain_body" ]; then
            err_msg="$(printf '%s' "$plain_body" | jq -r '.error.message // empty' 2>/dev/null)"
        fi

        # HTTP 4xx (tranne 408/429): errore permanente, inutile ritentare.
        if [ -n "$http_code" ] && [ "$http_code" -lt 500 ] && [ "$http_code" -ne 408 ] && [ "$http_code" -ne 429 ]; then
            echo "Errore HTTP $http_code dal server." >&2
            if [ -n "$err_msg" ]; then
                echo "Messaggio: $err_msg" >&2
            else
                echo "Risposta grezza: $(printf '%s' "$plain_body" | head -c 500)" >&2
            fi
            exit 1
        fi

        # Errore dal server nel body (anche con HTTP 2xx/5xx): retry solo se
        # transitorio, altrimenti errore definitivo.
        if [ -n "$err_msg" ]; then
            if is_transient_error "$err_msg"; then
                if retry_wait "$attempt" "$err_msg"; then
                    continue
                fi
                echo "Errore dal server: $err_msg" >&2
                echo "Raggiunto il numero massimo di tentativi ($((RETRIES + 1)))." >&2
                exit 1
            fi
            echo "Errore dal server: $err_msg" >&2
            exit 1
        fi

        # Connessione chiusa pulitamente senza contenuto interpretabile:
        # ritentabile (possibile fallimento transitorio del proxy).
        if retry_wait "$attempt" "stream chiuso senza contenuto"; then
            continue
        fi
        echo "Attenzione: nessun contenuto ricevuto dallo stream." >&2
        if [ -n "$http_code" ]; then
            dbg "Dettaglio (HTTP $http_code): $(printf '%s' "$plain_body" | head -c 500)"
        fi
        exit 1
    done

    echo ""  # newline finale dopo lo stream
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
main() {
    check_dependencies
    parse_args "$@"
    resolve_prompt

    if [ "$STREAM" = true ] && [ "$RACE_COUNT" -gt 1 ]; then
        echo "Errore: la modalità --race non è compatibile con --stream." >&2
        echo "Rimuovi --stream oppure --race per continuare." >&2
        exit 1
    fi

    if [ "$RACE_COUNT" -gt 1 ]; then
        # Ogni worker nel proprio process group: permette di killare l'intero
        # gruppo (curl + subshell) quando un altro worker ha già vinto.
        set -m
        RACE_PIDS=()
        RACE_TMPDIR=""
        trap 'race_cleanup; exit 130' INT
        trap 'race_cleanup; exit 143' TERM
    fi

    if [ -z "$API_KEY" ]; then
        dbg "Nota: nessuna API key impostata (OK per server locali come Ollama/LM Studio)."
    fi

    if [ "$STREAM" = true ]; then
        call_streaming
    else
        call_non_streaming
    fi
}

main "$@"
