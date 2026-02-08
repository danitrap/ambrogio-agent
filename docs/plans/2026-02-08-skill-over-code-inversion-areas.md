# Skill Over Code - Aree Rimanenti per Inversione di Pattern

> **Data:** 2026-02-08  
> **Obiettivo:** Documentare tutte le aree del codebase dove il parsing JSON/XML o l'iniezione di context possono essere convertiti all'approccio "skill > code"

## Aree Identificate

### 1. Heartbeat ⭐ PRIORITÀ ALTA
**File:** `src/runtime/heartbeat.ts`  
**Linee:** 19-114 (buildHeartbeatPrompt, parseHeartbeatDecision)

**Pattern attuale:**
- Modello risponde con `HEARTBEAT_OK` o JSON strutturato
- Codice fa parsing manuale con `parseHeartbeatDecision()`
- Lo status runtime viene iniettato nel prompt come testo
- Codice decide se inviare checkin/alert

**Inversione proposta:**
- Creare skill `heartbeat-controller` con accesso a `ambrogioctl` per:
  - Leggere lo status runtime (context file)
  - Chiamare tool `send_checkin(reason)` o `send_alert(issue, impact, nextStep)`
  - Chiamare tool `add_todo_item(text)` se necessario
- Il modello usa tool invece di rispondere con JSON
- Elimina completamente `parseHeartbeatDecision()`

**Beneficio:** Elimina parsing JSON completo, rende la logica heartbeat dichiarativa attraverso skill

**Sforzo:** Medio - Richiede estensione RPC per operazioni heartbeat

---

### 2. Telegram Response Mode & Documenti
**File:** `src/telegram/response-mode.ts`  
**Linee:** 9-42

**Pattern attuale:**
- Parsing XML tag `<response_mode>audio|text</response_mode>`
- Parsing tag `<telegram_document>path</telegram_document>`
- Logica di parsing nel codice TypeScript

**Inversione proposta:**
- Creare skill `telegram-response-formatter` con tool:
  - `set_response_mode(mode: "audio" | "text")`
  - `attach_document(filePath: string)`
- Il modello chiama tool invece di generare tag XML
- Il codice rimuove `parseTelegramResponse()` e gestisce solo tool calls

**Beneficio:** Elimina parsing XML fragile, usa tool calls standard

**Sforzo:** Basso - Richiede aggiunta di nuovi tool nel sistema

---

### 3. Conversation Context
**File:** `src/app/agent-service.ts`  
**Linee:** 105-116 (formatContextualMessage)

**Pattern attuale:**
- `formatContextualMessage()` inietta manualmente la cronologia nel prompt
- Serializzazione testuale delle ultime 8 interazioni
- Ogni messaggio include sempre tutto il context

**Inversione proposta:**
- Skill `conversation-manager` che legge la cronologia come context file
- Tool: `load_conversation(userId, limit?)` - ritorna cronologia
- Tool: `append_to_conversation(userId, role, text)` - aggiunge entry
- Il modello richiede il context quando serve invece di riceverlo sempre
- Opzionale: contesto caricato su richiesta per risparmiare token

**Beneficio:** Maggiore controllo sul context, risparmio token, elimina formattazione manuale

**Sforzo:** Medio - Richiede refactoring della gestione memoria

---

### 4. Status Command
**File:** `src/main.ts` (funzione inline in handleTelegramCommand)  
**Comando:** `/status`

**Pattern attuale:**
- Codice nativo raccoglie tutte le metriche runtime
- Formattazione manuale in stringa
- Logica hardcoded

**Inversione proposta:**
- Estendere `ambrogioctl` con: `ambrogioctl status --json`
- Skill `status-reporter` che:
  - Chiama `ambrogioctl status --json`
  - Formatta la risposta in modo user-friendly
  - Può essere personalizzata senza modificare codice

**Beneficio:** Formattazione flessibile, rimuove ~50 righe di formattazione da main.ts

**Sforzo:** Basso - Estensione RPC esistente

---

### 5. Memory Commands
**File:** `src/runtime/command-handlers.ts`  
**Comandi:** `/memory`, `/clear`

**Pattern attuale:**
- `getMemoryReply()` raccoglie statistiche conversazione
- `clearConversation()` e `clearRuntimeState()` gestite in codice

**Inversione proposta:**
- Skill `conversation-manager` (estensione della #3) con tool:
  - `get_conversation_stats(userId)`
  - `clear_conversation(userId)`
  - `clear_runtime_state()`
- Può usare ambrogioctl o context files

**Beneficio:** Consistente con pattern skill, rimuove logica gestione memoria dal core

**Sforzo:** Basso-Medio

---

### 6. Command Routing
**File:** `src/telegram/commands.ts`, `src/runtime/command-handlers.ts`

**Pattern attuale:**
- `parseTelegramCommand()` fa regex parsing dei comandi `/command`
- Switch-case in `handleTelegramCommand()` gestisce ogni comando
- Ogni comando ha logica specifica nel codice

**Inversione proposta:**
- Skill `command-router` che:
  - Riceve il testo del comando
  - Decide quale skill/tool chiamare
  - Gestisce comandi come `/skills`, `/status`, `/memory` attraverso skill specializzate
- Gradualmente convertire ogni comando nativo a skill-based

**Beneficio:** Comandi estensibili via skill, rimuove switch-case monolitico

**Sforzo:** Medio-Alto - Richiede refactoring architetturale graduale

---

## Priorità di Implementazione

1. **Heartbeat** - Alto impatto, elimina parsing JSON complesso
2. **Status Command** - Basso sforzo, buon esempio per pattern
3. **Telegram Response Mode** - Semplifica formattazione risposte
4. **Memory Commands** - Complementa conversation manager
5. **Conversation Context** - Miglioramento architetturale significativo
6. **Command Routing** - Obiettivo a lungo termine per architettura completamente skill-based

## Note sulla Filosofia "Skill > Code"

Ogni area convertita a skill:
- **Rimuove parsing** dal codice TypeScript (più robusto)
- **Abilita personalizzazione** senza modificare codice (skill modificabili)
- **Centralizza la logica** in un unico punto (la skill)
- **Permette estensioni** future (nuovi tool nella skill)
- **Riduce il core** del sistema (meno codice = meno bug)

## Pattern Comune

Tutte le conversioni seguono questo pattern:

```
[User Input] 
    ↓
[Parsing/Formattazione nel codice] 
    ↓
[Logica decisionale nel codice]
    ↓
[Risposta]
```

Diventa:

```
[User Input]
    ↓
[Skill Detection]
    ↓
[Skill con Tool Calls]
    ↓
[Risposta]
```

La skill usa `ambrogioctl` o tool dedicati per interagire con lo stato del sistema.
