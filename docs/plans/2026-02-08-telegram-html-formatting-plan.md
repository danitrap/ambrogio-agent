# Telegram HTML Formatting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rendere robusta la formattazione dei messaggi Telegram passando da testo Markdown grezzo a invio HTML sicuro e prevedibile.

**Architecture:** Manteniamo il flusso attuale (`sendTelegramTextReply -> TelegramAdapter.sendMessage`) ma introduciamo una normalizzazione del testo prima dell'invio. La normalizzazione converte Markdown comune in HTML supportato da Telegram, esegue escaping dei caratteri pericolosi e protegge da errori di rendering con fallback plain text se Telegram rifiuta il payload formattato.

**Tech Stack:** TypeScript (Bun), Telegram Bot API (`sendMessage` con `parse_mode: "HTML"`), `bun:test`.

---

### Task 1: Definire il comportamento con test (TDD)

**Files:**
- Modify: `test/telegram-adapter.test.ts`
- Modify: `test/message-sender.test.ts`
- Create: `test/telegram-formatting.test.ts`

**Step 1: Scrivere test fallenti per parse mode HTML nell'adapter**
- Aggiungere un test che verifica che `sendMessage` mandi `parse_mode: "HTML"`.
- Aggiungere un test che verifica che il payload includa il testo trasformato (non Markdown raw, quando applicabile).

**Step 2: Scrivere test fallenti per conversione base Markdown->HTML**
- In `test/telegram-formatting.test.ts`, coprire almeno:
  - `**bold**` -> `<b>bold</b>`
  - `_italic_` -> `<i>italic</i>`
  - `` `code` `` -> `<code>code</code>`
  - blocchi triplo backtick -> `<pre>...</pre>`
  - escape di `&`, `<`, `>` nel testo non-markup.

**Step 3: Scrivere test fallente per fallback plain text**
- In `test/message-sender.test.ts`, simulare errore adapter su invio HTML e verificare secondo invio plain text.

**Step 4: Eseguire i test mirati e verificare che falliscano**
- Run: `bun test test/telegram-adapter.test.ts test/telegram-formatting.test.ts test/message-sender.test.ts`
- Expected: FAIL sui nuovi casi.

**Step 5: Commit checkpoint**
- `git add test/telegram-adapter.test.ts test/telegram-formatting.test.ts test/message-sender.test.ts`
- `git commit -m "test: define telegram html formatting behavior"`

### Task 2: Implementare formatter Telegram-safe

**Files:**
- Create: `src/telegram/formatting.ts`
- Modify: `src/runtime/message-sender.ts`

**Step 1: Implementare conversione Markdown->HTML minimale e sicura**
- Creare funzioni pure:
  - `escapeHtml(text: string): string`
  - `formatTelegramHtml(text: string): string`
  - `stripMarkdown(text: string): string` (fallback leggibile)
- Gestire prima i blocchi code/pre, poi inline code, poi enfasi (`**`, `_`) per ridurre conflitti.

**Step 2: Integrare formatter nel sender runtime**
- In `sendTelegramTextReply`, costruire:
  - `htmlText` (versione formattata)
  - `fallbackText` (plain text)
- Inviare `htmlText` come primo tentativo.

**Step 3: Gestire fallback robusto**
- Se il primo invio fallisce con errore Telegram collegato a parse/format, ritentare con `fallbackText` senza markup.
- Conservare log diagnostico leggero (`formatMode: html|plain_fallback`).

**Step 4: Eseguire test task 2**
- Run: `bun test test/telegram-formatting.test.ts test/message-sender.test.ts`
- Expected: PASS.

**Step 5: Commit checkpoint**
- `git add src/telegram/formatting.ts src/runtime/message-sender.ts`
- `git commit -m "feat: add telegram-safe html formatting and fallback"`

### Task 3: Aggiornare adapter Telegram con parse_mode HTML

**Files:**
- Modify: `src/telegram/adapter.ts`
- Modify: `test/telegram-adapter.test.ts`

**Step 1: Estendere sendMessage per parse mode esplicito**
- Aggiornare firma metodo per supportare opzioni (`parseMode` opzionale) oppure fissare default HTML per i soli messaggi di testo.
- In body `sendMessage`, includere `parse_mode: "HTML"` quando si invia testo formattato.

**Step 2: Allineare test adapter**
- Verificare serializzazione corretta nel payload JSON.
- Verificare nessuna regressione su metodi `sendAudio` e `sendDocument`.

**Step 3: Eseguire test task 3**
- Run: `bun test test/telegram-adapter.test.ts`
- Expected: PASS.

**Step 4: Commit checkpoint**
- `git add src/telegram/adapter.ts test/telegram-adapter.test.ts`
- `git commit -m "feat: send telegram text messages with html parse mode"`

### Task 4: Verifica completa e hardening operativo

**Files:**
- (nessun nuovo file obbligatorio)

**Step 1: Eseguire suite completa**
- Run: `bun test`
- Expected: PASS.

**Step 2: Verifica type safety**
- Run: `bun run typecheck`
- Expected: PASS senza emit.

**Step 3: Rebuild runtime container**
- Run: `docker compose up -d --build`
- Expected: container up e runtime aggiornato.

**Step 4: Smoke test manuale Telegram**
- Inviare prompt con:
  - grassetto/corsivo/code/link
  - caratteri speciali (`<`, `>`, `&`)
  - messaggio non markdown
- Atteso: rendering corretto o fallback plain text senza errore visibile.

**Step 5: Commit finale**
- `git add -A`
- `git commit -m "fix: robust telegram message formatting via html mode"`
