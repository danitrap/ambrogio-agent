---
name: structured-notes
description: Gestione di note strutturate con tag e ricerca per appunti di progetto, decisioni e log rapidi. Usa quando l'utente chiede di creare, aggiornare, cercare o riassumere note con metadati, tag o filtri temporali, con persistenza tramite ambrogioctl e un DB/state store.
---

# Structured Notes

Gestire note strutturate usando `ambrogioctl state` come DB leggero.

## Modello dati

- **Key**: `notes:entry:<note_id>`
- **Value**: JSON con campi:
  - `id` (string)
  - `type` (project | decision | log)
  - `title` (string)
  - `body` (string)
  - `tags` (array di string)
  - `project` (string | null)
  - `created_at` (ISO 8601)
  - `updated_at` (ISO 8601)
  - `status` (open | closed | archived)
  - `links` (array di string | facoltativo)

## Creare una nota

Genera un `note_id` stabile e salva il JSON.

```bash
note_id="note-$(date -Iseconds | tr -d ':')"
created_at="$(date -Iseconds)"
updated_at="$created_at"
note_id="$note_id" created_at="$created_at" updated_at="$updated_at" python3 - <<'PY'
import json, os
note = {
  "id": os.environ["note_id"],
  "type": "project",
  "title": "Sintesi kickoff",
  "body": "Allineati su scope e milestones.",
  "tags": ["kickoff", "scope"],
  "project": "Ambrogio",
  "created_at": os.environ["created_at"],
  "updated_at": os.environ["updated_at"],
  "status": "open",
  "links": []
}
print(json.dumps(note, ensure_ascii=True))
PY
```

Poi salva:

```bash
ambrogioctl state set "notes:entry:${note_id}" "<json>"
```

## Aggiornare una nota

1) Recupera il JSON
2) Modifica `body`, `tags`, `status` e aggiorna `updated_at`.

```bash
raw=$(ambrogioctl state get "notes:entry:${note_id}" 2>/dev/null | cut -d= -f2-)
updated_at="$(date -Iseconds)"
raw="$raw" updated_at="$updated_at" python3 - <<'PY'
import json, os
raw = os.environ.get("raw")
if raw:
  note = json.loads(raw)
  note["body"] = note["body"] + "\n- Azione: inviare proposta."
  note["tags"] = sorted(set(note["tags"] + ["azione"]))
  note["updated_at"] = os.environ.get("updated_at")
  print(json.dumps(note, ensure_ascii=True))
PY
```

Salva il risultato in `notes:entry:${note_id}`.

## Cercare per tag/keyword

Metodo robusto (con `--json`):

```bash
ambrogioctl state list --pattern "notes:entry:*" --json | python3 - <<'PY'
import json, sys
needle = "decision".lower()
want_tag = "security"
entries = json.load(sys.stdin).get("entries", [])
for e in entries:
  key = e.get("key")
  value = e.get("value")
  if not value:
    continue
  note = json.loads(value)
  hay = (note.get("title", "") + "\n" + note.get("body", "")).lower()
  tags = [t.lower() for t in note.get("tags", [])]
  if needle in hay and (not want_tag or want_tag.lower() in tags):
    print(f"{note.get('id')} | {note.get('title')}")
PY
```

Fallback senza `--json`:

```bash
for key in $(ambrogioctl state list --pattern "notes:entry:*" 2>/dev/null); do
  val=$(ambrogioctl state get "$key" 2>/dev/null | cut -d= -f2-)
  echo "$val" | grep -qi "decision" && echo "$key"
done
```

## Decision log

- Usa `type="decision"`.
- Nel `body`, includi sempre: **contesto**, **decisione**, **alternative scartate**, **impatti**.

## Log rapidi

- Usa `type="log"`.
- Titolo breve + timestamp.
- Tag obbligatorio per area (es. `ops`, `legal`, `sales`).

## Output atteso verso l'utente

- Conferma azione (creata/aggiornata/trovata).
- Riporta `note_id`, titolo, tag principali.
- Se ricerca: numero risultati + top 3 con titolo.
