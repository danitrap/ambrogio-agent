---
name: heartbeat
description: Periodic system health check with full context access and autonomous decision making. Checks conversation history to determine if checkins are needed and resurfaces pending unresolved items.
---

# Heartbeat System Monitor

Esegui un check periodico dello stato del sistema, con accesso completo al contesto, e decidi autonomamente se inviare notifiche su Telegram.

## Capacità e Tool Disponibili

Hai accesso completo a:

- **Read**: Leggere qualsiasi file in `/data` (TODO.md, HEARTBEAT.md, codice, log, ecc.)
- **Bash**: Eseguire comandi (git status, ps, df, uptime, ecc.)
- **Grep/Glob**: Cercare file e contenuti nel progetto
- **ambrogioctl**: Accedere a status runtime, task, inviare messaggi Telegram
- **StateStore**: Via ambrogioctl, puoi leggere/scrivere valori persistenti per deduplication
- **Conversation API**: Via ambrogioctl, puoi accedere alla cronologia conversazioni

## Workflow

1. **Leggi la policy**: Leggi `/data/HEARTBEAT.md` per le regole di comportamento
   - Contiene: quiet hours, thresholds, condizioni per alert/checkin, regole dedup

2. **Raccogli contesto**: Esplora lo stato del sistema
   - Runtime status: `ambrogioctl status --json`
   - Task pending: `ambrogioctl tasks list`
   - TODO items: `cat /data/TODO.md`
   - Git status: `git -C /data status --short` (se applicabile)
   - **Conversation history**: `ambrogioctl conversation stats --user-id <UID>` e `ambrogioctl conversation list --user-id <UID>`
   - Qualsiasi altro file/comando rilevante per la policy

3. **Valuta policy**: Determina se serve un'azione
   - Verifica thresholds (idle time, task age, ecc.)
   - **Verifica conversazione**: Quanto tempo è passato dall'ultimo messaggio?
   - **Controlla pending items**: Ci sono richieste non risolte nella conversazione?
   - Decidi: niente, checkin, o alert

4. **Agisci autonomamente**:
   - **Se niente da fare**: Semplicemente termina (non servono azioni)
   - **Se checkin necessario**: Componi messaggio e invia con ambrogioctl
   - **Se alert necessario**: Componi messaggio urgente e invia con ambrogioctl
   - **Se pending items**: Resurface richieste non completate

## Conversation-Aware Checkins

Usa la conversation API per decidere se inviare un checkin:

### Ottieni User ID

```bash
USER_ID="${TELEGRAM_ALLOWED_USER_ID:-123456}"  # Sostituisci con l'ID corretto
```

### Controlla Ultima Attività

```bash
# Ottieni statistiche conversazione
conv_stats=$(ambrogioctl conversation stats --user-id "$USER_ID" --json 2>/dev/null)

if [[ -n "$conv_stats" ]]; then
  # Estrai numero di entry
  entries=$(echo "$conv_stats" | jq -r '.entries // 0')
  
  if [[ "$entries" -eq 0 ]]; then
    echo "Nessuna conversazione trovata - potrebbe essere un buon momento per un checkin iniziale"
  fi
fi

# Ottieni lista conversazioni recenti
conv_list=$(ambrogioctl conversation list --user-id "$USER_ID" --limit 1 --json 2>/dev/null)

if [[ -n "$conv_list" ]]; then
  # Estrai timestamp ultimo messaggio
  last_message_time=$(echo "$conv_list" | jq -r '.entries[-1].createdAt // empty')
  
  if [[ -n "$last_message_time" ]]; then
    # Calcola ore dall'ultimo messaggio
    last_epoch=$(date -d "$last_message_time" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "$last_message_time" +%s 2>/dev/null)
    now_epoch=$(date +%s)
    hours_since_last=$(( (now_epoch - last_epoch) / 3600 ))
    
    echo "Ultimo messaggio: $hours_since_last ore fa"
    
    # Se più di 6 ore di silenzio durante il giorno, suggerisci checkin
    if [[ $hours_since_last -gt 6 ]]; then
      current_hour=$(date +%H)
      if [[ $current_hour -ge 8 && $current_hour -lt 22 ]]; then
        echo "Checkin consigliato: silenzio da $hours_since_last ore durante orario diurno"
      fi
    fi
  fi
fi
```

### Invia Checkin Basato su Conversazione

```bash
send_conversation_checkin() {
  local hours_idle="$1"
  
  # Messaggio contestuale basato sul tempo di inattività
  if [[ $hours_idle -gt 24 ]]; then
    message="Buongiorno signor Daniele! Non ci sentiamo da ${hours_idle} ore. Tutto bene? A cosa sta lavorando oggi?"
  elif [[ $hours_idle -gt 12 ]]; then
    message="Ciao! Sono passate ${hours_idle} ore dall'ultimo messaggio. Hai bisogno di aiuto con qualcosa?"
  else
    message="Check-in: come procede? Posso aiutarla con qualche task?"
  fi
  
  ambrogioctl telegram send-message --text "$message"
}
```

## Pending Items Detection

Analizza la conversazione per trovare richieste non risolte:

### Pattern di Richieste Non Risolte

```bash
find_pending_requests() {
  local user_id="$1"
  local pending_items=()
  
  # Ottieni ultime N entry della conversazione
  conv_export=$(ambrogioctl conversation export --user-id "$user_id" --format json 2>/dev/null)
  
  if [[ -z "$conv_export" ]]; then
    return
  fi
  
  # Analizza coppie user/assistant
  # Se un messaggio utente contiene "?" o richieste d'azione, 
  # verifica che ci sia stata una risposta adeguata
  
  entries=$(echo "$conv_export" | jq -r '.entries // []')
  entry_count=$(echo "$entries" | jq 'length')
  
  for ((i=0; i<$entry_count-1; i++)); do
    current_entry=$(echo "$entries" | jq -r ".[$i]")
    next_entry=$(echo "$entries" | jq -r ".[$i+1]")
    
    current_role=$(echo "$current_entry" | jq -r '.role')
    current_text=$(echo "$current_entry" | jq -r '.text')
    next_role=$(echo "$next_entry" | jq -r '.role')
    
    # Se l'utente ha fatto una domanda o richiesta
    if [[ "$current_role" == "user" ]]; then
      # Pattern che indicano richieste
      if echo "$current_text" | grep -qiE "\?|puoi|potresti|fai|crea|genera|controlla|invia|manda"; then
        # Verifica se c'è stata risposta adeguata
        if [[ "$next_role" != "assistant" ]]; then
          # Richiesta senza risposta!
          pending_items+=("$current_text")
        fi
      fi
    fi
  done
  
  # Stampa items pendenti
  for item in "${pending_items[@]}"; do
    echo "PENDING: $item"
  done
}
```

### TODO Mention Detection

```bash
find_todo_mentions() {
  local user_id="$1"
  
  # Cerca menzioni di TODO nella conversazione
  conv_export=$(ambrogioctl conversation export --user-id "$user_id" --format json 2>/dev/null)
  
  if [[ -n "$conv_export" ]]; then
    # Estrai messaggi che menzionano TODO/task
    todo_mentions=$(echo "$conv_export" | jq -r '.entries[] | select(.text | test("todo|task|da fare|promemoria|reminder"; "i")) | "[\(.role)] \(.text)"' 2>/dev/null)
    
    if [[ -n "$todo_mentions" ]]; then
      echo "Menzioni di TODO trovate:"
      echo "$todo_mentions"
    fi
  fi
}
```

### Invia Alert per Items Pendenti

```bash
send_pending_alert() {
  local pending_count="$1"
  local oldest_pending="$2"
  
  if [[ $pending_count -gt 0 ]]; then
    message="⚠️ Alert heartbeat:
Signor Daniele, ho notato che ci sono ${pending_count} richieste in sospeso dall'ultima conversazione.

Ad esempio: \"${oldest_pending}\"

Può darmi un aggiornamento su cosa è stato fatto o se ha bisogno di aiuto?"
    
    ambrogioctl telegram send-message --text "$message"
  fi
}
```

## State Tracking per Heartbeat

Mantieni traccia degli alert inviati:

```bash
# Chiavi state usate da heartbeat
# heartbeat:last_checkin - timestamp ultimo checkin
# heartbeat:last_alert - timestamp ultimo alert
# heartbeat:pending_acknowledged - lista items pendenti già notificati

record_heartbeat_action() {
  local action="$1"  # checkin, alert, pending_alert
  local now=$(date -Iseconds)
  
  ambrogioctl state set "heartbeat:last_${action}" "$now"
}

check_recent_alert() {
  local action="$1"
  local min_hours="${2:-2}"
  
  local last=$(ambrogioctl state get "heartbeat:last_${action}" 2>/dev/null | cut -d= -f2-)
  
  if [[ -n "$last" ]]; then
    local last_epoch=$(date -d "$last" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "$last" +%s 2>/dev/null)
    local now_epoch=$(date +%s)
    local hours_since=$(( (now_epoch - last_epoch) / 3600 ))
    
    if [[ $hours_since -lt $min_hours ]]; then
      echo "Recente: ultimo ${action} ${hours_since} ore fa (minimo: ${min_hours})"
      return 1  # Troppo recente
    fi
  fi
  
  return 0  # OK inviare
}
```

## Esempio Completo Workflow

```bash
#!/bin/bash

USER_ID="${TELEGRAM_ALLOWED_USER_ID:-123456}"

# 1. Controlla ultima attività
conv_stats=$(ambrogioctl conversation stats --user-id "$USER_ID" --json 2>/dev/null)
entries=$(echo "$conv_stats" | jq -r '.entries // 0')

if [[ "$entries" -eq 0 ]]; then
  # Nessuna conversazione - checkin iniziale
  if check_recent_alert "checkin" 24; then
    ambrogioctl telegram send-message --text "Buongiorno signor Daniele! Sono qui e pronto ad aiutarla. A cosa posso essere utile oggi?"
    record_heartbeat_action "checkin"
  fi
  exit 0
fi

# 2. Calcola tempo dall'ultimo messaggio
conv_list=$(ambrogioctl conversation list --user-id "$USER_ID" --limit 1 --json 2>/dev/null)
last_time=$(echo "$conv_list" | jq -r '.entries[-1].createdAt // empty')

if [[ -n "$last_time" ]]; then
  last_epoch=$(date -d "$last_time" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "$last_time" +%s 2>/dev/null)
  now_epoch=$(date +%s)
  hours_since=$(( (now_epoch - last_epoch) / 3600 ))
  
  echo "Ore dall'ultimo messaggio: $hours_since"
  
  # 3. Cerca items pendenti se inattivo da > 2 ore
  if [[ $hours_since -gt 2 ]]; then
    pending=$(find_pending_requests "$USER_ID")
    pending_count=$(echo "$pending" | grep -c "^PENDING:" || echo 0)
    
    if [[ $pending_count -gt 0 ]]; then
      # C'è roba pendente - invia alert
      if check_recent_alert "alert" 4; then
        oldest=$(echo "$pending" | grep "^PENDING:" | head -1 | sed 's/^PENDING: //')
        send_pending_alert "$pending_count" "$oldest"
        record_heartbeat_action "alert"
      fi
    elif [[ $hours_since -gt 6 ]]; then
      # No pending ma silenzio lungo - checkin
      current_hour=$(date +%H)
      if [[ $current_hour -ge 8 && $current_hour -lt 22 ]]; then
        if check_recent_alert "checkin" 6; then
          send_conversation_checkin "$hours_since"
          record_heartbeat_action "checkin"
        fi
      fi
    fi
  fi
fi

# 4. Controlla anche TODO, task pending, etc.
# ... (codice esistente)
```

## Invio Messaggi Telegram

**NON usare mai XML tags o JSON responses.** Invece, chiama direttamente ambrogioctl:

```bash
# Per checkin (informational)
ambrogioctl telegram send-message --text "Heartbeat check-in:
Buongiorno/Buonasera signor Daniele. A cosa stai lavorando?"
# Oppure qualsiasi altro spunto per iniziare conversazione

# Per alert (critico)
ambrogioctl telegram send-message --text "⚠️ Heartbeat alert:
Buongiorno/Buonasera signor Daniele, ha un TODO scaduto da 3 giorni: controlla la posta"
# O qualcosa del genere
```

## Hard Rules

- **MAI usare tag XML** o restituire JSON structured responses
- **MAI chiamare tool non disponibili** senza verificare prima (es: test con bash)
- **Sii parsimonioso**: invia solo se veramente necessario
- **Descrizioni chiare**: issue, impact, next step devono essere actionable
- **Quiet hours**: Sono gestiti dal sistema prima dell'esecuzione della skill, non devi controllarli tu
- **Deduplication**: È stata rimossa - puoi notificare ogni mezzora se c'è qualcosa di importante
- **Conversation-aware**: Usa la cronologia conversazione per contestualizzare i checkin
