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
MODEL="${OPENAI_MODEL:-google/gemma-4-e4b}"
BASE_URL="${OPENAI_BASE_URL:-http://localhost:1234/v1}"
API_KEY="${OPENAI_API_KEY:-test}"
SYSTEM_PROMPT=""
STREAM=false
PROMPT=""

# Parametri opzionali di generazione (vuoti = non inviati nel payload)
TEMPERATURE=""
TOP_P=""
MAX_TOKENS=""
CONTEXT_WINDOW=""      # mappato su "options.num_ctx" (convenzione Ollama)
REASONING_EFFORT="none"    # mappato su "reasoning_effort" (convenzione OpenAI o-series)

# Parametri extra generici, forma "chiave.puntata=valore", ripetibile
EXTRA_PARAMS=()

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
# Chiamata non-streaming: cattura la risposta completa e la stampa con jq
# ----------------------------------------------------------------------------
call_non_streaming() {
    local payload response http_code body

    payload="$(build_payload false)"

    response="$(curl -sS -w '\n%{http_code}' \
        --connect-timeout 10 \
        -X POST "${BASE_URL}/chat/completions" \
        -H "Content-Type: application/json" \
        ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
        -d "$payload" 2>&1)"
    local curl_exit=$?

    if [ $curl_exit -ne 0 ]; then
        echo "Errore: impossibile contattare l'endpoint '${BASE_URL}'." >&2
        echo "Dettaglio curl: $response" >&2
        exit 1
    fi

    http_code="$(echo "$response" | tail -n1)"
    body="$(echo "$response" | sed '$d')"

    if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
        echo "Errore HTTP $http_code dal server." >&2
        local err_msg
        err_msg="$(echo "$body" | jq -r '.error.message // empty' 2>/dev/null)"
        if [ -n "$err_msg" ]; then
            echo "Messaggio: $err_msg" >&2
        else
            echo "Risposta grezza: $body" >&2
        fi
        exit 1
    fi

    if ! echo "$body" | jq -e '.choices[0].message.content' >/dev/null 2>&1; then
        echo "Errore: risposta inattesa dal server (formato non riconosciuto)." >&2
        echo "Risposta grezza: $body" >&2
        exit 1
    fi

    echo "$body" | jq -r '.choices[0].message.content'
}

# ----------------------------------------------------------------------------
# Chiamata streaming: legge SSE riga per riga ed estrae i "delta" al volo
# ----------------------------------------------------------------------------
call_streaming() {
    local payload
    payload="$(build_payload true)"

    local had_output=false
    local error_seen=false

    while IFS= read -r line; do
        [[ "$line" == data:\ * ]] || continue
        local data="${line#data: }"

        if [ "$data" = "[DONE]" ]; then
            break
        fi

        local err_msg
        err_msg="$(echo "$data" | jq -r '.error.message // empty' 2>/dev/null)"
        if [ -n "$err_msg" ]; then
            echo "" >&2
            echo "Errore dal server durante lo streaming: $err_msg" >&2
            error_seen=true
            break
        fi

        local token
        token="$(echo "$data" | jq -r '.choices[0].delta.content // empty' 2>/dev/null)"
        if [ -n "$token" ]; then
            printf '%s' "$token"
            had_output=true
        fi
    done < <(curl -sS -N \
                --connect-timeout 10 \
                -X POST "${BASE_URL}/chat/completions" \
                -H "Content-Type: application/json" \
                -H "Accept: text/event-stream" \
                ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
                -d "$payload")
    local curl_exit=${PIPESTATUS[0]:-$?}

    echo ""  # newline finale dopo lo stream

    if [ "$error_seen" = true ]; then
        exit 1
    fi

    if [ "$curl_exit" -ne 0 ]; then
        echo "Errore: connessione allo stream fallita (endpoint '${BASE_URL}')." >&2
        exit 1
    fi

    if [ "$had_output" = false ]; then
        echo "Attenzione: nessun contenuto ricevuto dallo stream." >&2
        exit 1
    fi
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
main() {
    check_dependencies
    parse_args "$@"
    resolve_prompt

    if [ -z "$API_KEY" ]; then
        echo "Nota: nessuna API key impostata (OK per server locali come Ollama/LM Studio)." >&2
    fi

    if [ "$STREAM" = true ]; then
        call_streaming
    else
        call_non_streaming
    fi
}

main "$@"
