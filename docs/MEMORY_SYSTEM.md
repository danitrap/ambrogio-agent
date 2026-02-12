# Sistema di Memoria per Ambrogio Agent

## Stato Implementazione

✅ **Fase 1: Core Infrastructure** - COMPLETATA
✅ **Fase 2: Skill Memory Manager** - COMPLETATA

## Architettura

### Storage Layer

**Dual Backend:**
- **SQLite (Source of Truth)**: Tabella `runtime_kv` con pattern `memory:<type>:<id>`
- **MEMORY.md (Human Interface)**: File markdown generato da SQLite, editabile dall'utente

### Schema Memoria

```json
{
  "id": "mem-2026-02-12-abc123",
  "type": "preference" | "fact" | "pattern",
  "content": "usa sempre bun",
  "source": "explicit" | "extracted",
  "confidence": 100,
  "createdAt": "2026-02-12T14:30:00Z",
  "updatedAt": "2026-02-12T14:30:00Z",
  "lastAccessedAt": "2026-02-12T14:30:00Z",
  "tags": ["tooling", "package-manager"],
  "context": "User said: ricorda che uso sempre bun",
  "status": "active" | "deprecated" | "archived"
}
```

## Componenti Implementati

### 1. RPC Server Operations (`src/runtime/job-rpc-server.ts`)

Operazioni disponibili:
- `memory.add` - Crea memoria
- `memory.get` - Recupera memoria per ID
- `memory.list` - Elenca memorie (con filtro opzionale per tipo)
- `memory.search` - Ricerca full-text per query
- `memory.delete` - Elimina memoria
- `memory.sync` - Conferma disponibilità sync

### 2. CLI Commands (`src/cli/ambrogioctl.ts`)

Scope `memory` con comandi:
```bash
ambrogioctl memory add --type <type> --content "<text>" [options]
ambrogioctl memory get --id <id> --type <type>
ambrogioctl memory list [--type <type>]
ambrogioctl memory search --query "<query>"
ambrogioctl memory delete --id <id> --type <type>
ambrogioctl memory sync [--output <path>]
```

### 3. Memory Manager Skill (`skills/memory-manager/`)

Scripts disponibili:
- `add.sh` - Wrapper per aggiungere memoria
- `search.sh` - Ricerca memoria
- `list.sh` - Elenca memorie
- `sync.sh` - Rigenera MEMORY.md
- `deprecate.sh` - Marca memoria come deprecated

### 4. AGENTS.md Updates

Istruzioni aggiunte per:
- Quando consultare la memoria
- Come catturare memorie esplicite
- Come accedere alla memoria (quick check, structured query)

## Utilizzo

### Cattura Esplicita

```bash
# Via CLI
ambrogioctl memory add --type preference --content "usa sempre bun" --tags "tooling"

# Via skill
cd skills/memory-manager
./scripts/add.sh --type preference --content "usa sempre bun" --tags "tooling"
```

### Ricerca

```bash
# Via CLI
ambrogioctl memory search --query "bun"

# Via skill
./scripts/search.sh --query "bun"
```

### Sync MEMORY.md

```bash
# Via CLI
ambrogioctl memory sync

# Via skill
./scripts/sync.sh
```

### Quick Check

```bash
# Leggi file human-readable
cat /data/MEMORY.md
```

## Test Coverage

✅ Test unitari per operazioni RPC
✅ Test CLI per tutti i comandi memory
✅ Test sync generation
✅ Test end-to-end per skill scripts

Totale: 15 test, tutti passati

## Prossime Fasi

### Fase 3: Heartbeat Integration (DA IMPLEMENTARE)

- [ ] Modificare `getRuntimeStatus()` in `main.ts`
- [ ] Caricare top 5 memorie (confidence > 80%)
- [ ] Passare memorie a `heartbeat-responder` skill
- [ ] Test reminder proattivi

### Fase 4: Polish & Management (DA IMPLEMENTARE)

- [ ] Retention policies (deprecation, archival)
- [ ] Conflict detection & resolution
- [ ] Edit bidirezionale MEMORY.md ↔ SQLite
- [ ] User documentation

### Fase 5: Estrazione Automatica (OPZIONALE)

- [ ] Script `extract.sh` per analisi conversazioni
- [ ] Proposta memorie candidate all'utente
- [ ] Integrazione con job ricorrenti

## Note Tecniche

### Pattern Chiavi SQLite

```
memory:preference:<id>  # Preferenze utente
memory:fact:<id>        # Fatti e conoscenze
memory:pattern:<id>     # Pattern comportamentali
```

### Confidence Scores

- **100**: Esplicito, confermato dall'utente
- **80-99**: Alta confidenza, osservato più volte
- **60-79**: Media confidenza, da verificare
- **< 60**: Bassa confidenza, proposto ma non confermato

### Status Lifecycle

1. **active**: Memoria in uso
2. **deprecated**: Superseded da informazione più recente
3. **archived**: Non più rilevante, nascosta da MEMORY.md

## Compatibilità

- **Bun**: Richiesto per esecuzione TypeScript
- **SQLite**: Già presente (Bun:sqlite)
- **jq**: Richiesto per `deprecate.sh` (gestione JSON)
