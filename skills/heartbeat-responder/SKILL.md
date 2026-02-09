---
name: heartbeat
description: Periodic system health check with full context access and autonomous decision making
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

## Workflow

1. **Leggi la policy**: Leggi `/data/HEARTBEAT.md` per le regole di comportamento
   - Contiene: quiet hours, thresholds, condizioni per alert/checkin, regole dedup

2. **Raccogli contesto**: Esplora lo stato del sistema
   - Runtime status: `ambrogioctl status --json`
   - Task pending: `ambrogioctl tasks list`
   - TODO items: `cat /data/TODO.md`
   - Git status: `git -C /data status --short` (se applicabile)
   - Conversation context: dall'output di ambrogioctl status
   - Qualsiasi altro file/comando rilevante per la policy

3. **Valuta policy**: Determina se serve un'azione
   - Verifica thresholds (idle time, task age, ecc.)
   - Decidi: niente, checkin, o alert

4. **Agisci autonomamente**:
   - **Se niente da fare**: Semplicemente termina (non servono azioni)
   - **Se checkin necessario**: Componi messaggio e invia con ambrogioctl
   - **Se alert necessario**: Componi messaggio urgente e invia con ambrogioctl

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
