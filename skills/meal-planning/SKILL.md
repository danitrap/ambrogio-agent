---
name: meal-planning
description: Pianifica pasti usando la dispensa/frigo in /data/groceries.md (letto tramite la skill gia esistente). Applica la filosofia a building blocks (proteina + carbo + fibre + grassi opzionali) e genera un piano pratico.
---

# Meal Planning Skill

## Scopo

Generare piani pasto (giornalieri o settimanali) basati esclusivamente su cio che l'utente ha gia in casa, seguendo un approccio modulare a building blocks.

Fonte inventario: `/data/groceries.md`  
Nota: la lettura/scrittura del file e gestita da un'altra skill gia presente. Questa skill deve delegare accesso al file e lavorare sui contenuti.

## Quando usare questa skill

Usa questa skill quando l'utente chiede:

- Pianificazione pasti / menu settimanale
- Idee pasti basate su quello che c'e in casa
- Combinazioni "proteiche" o "macro-friendly" con ingredienti disponibili
- "Svuotare frigo/dispensa" o ridurre sprechi

## Quando NON usarla

- Se l'utente chiede ricette dettagliate stile food blog (in quel caso: generare 1 ricetta specifica, non un piano).
- Se l'utente chiede una lista della spesa (in quel caso: proponi lista spesa solo come output secondario e minimale, se mancano 1-2 ingredienti critici).

## Input che questa skill dovrebbe accettare

- Orizzonte: `oggi`, `2 giorni`, `settimana`, `N pasti`
- Vincoli: "no cucinare a pranzo", "solo air fryer", "poche stoviglie", "pasti veloci"
- Preferenze: building blocks preferiti, ingredienti da finire presto, avversioni
- (Opzionale) Macro target giornalieri o per pasto

Se mancano dettagli, applica default ragionevoli:

- 2 pasti principali + 1 snack
- Ripetizione intelligente (massimo 2 volte lo stesso pasto nella settimana)
- Priorita a ingredienti deperibili

## Procedura

1) Leggi l'inventario chiamando la skill esistente che restituisce il contenuto di `/data/groceries.md`.
2) Parsa e normalizza gli item:
   - Uniforma nomi (es. "yogurt greco 0%" = yogurt greco)
   - Se ci sono quantita, conservale; se mancano, assumi quantita non note
   - Se ci sono note tipo "da finire", "scade", "aperto", trattale come priorita
3) Classifica ogni item in categorie:
   - Proteine (carni, pesce, uova, latticini proteici, legumi, tofu/seitan)
   - Carbo (riso, pasta, pane, tortillas, patate, avena)
   - Fibre/verdure (verdure, insalate, legumi se usati come "volume")
   - Grassi/condimenti (olio evo, frutta secca, burro d'arachidi, formaggi grassi)
   - Extra (salse, spezie, dolci, snack)
4) Costruisci un set di combo base (building blocks):
   - Template Bowl: proteina + carbo + verdura + condimento
   - Template Wrap: tortilla/pane + proteina + salsa/verdura
   - Template Pasta/Riso: carbo + proteina + sugo/verdura
   - Template Low-carb: proteina + verdura + grassi misurati
   Ogni combo deve usare solo ingredienti presenti (o al massimo 1 micro-eccezione tipo limone/spezie, se plausibile).
5) Assembla il piano:
   - Distribuisci proteine lungo la settimana
   - Non ripetere identico nello stesso giorno
   - Usa prima cio che e piu deperibile (se indicato nel file)
   - Se l'utente ha allenamento/alta attivita (se noto), metti piu carbo nei pasti attorno a quello
6) Output chiaro e operativo:
   - Piano giorno per giorno (colazione/pranzo/cena/snack) O elenco di N pasti pronti
   - Prep in batch suggerito (es. cuoci 400g pollo e 2 porzioni riso)
   - Da finire prima (2-5 item)
   - (Opzionale) Mini lista spesa solo se serve per sbloccare 80% dei pasti (max 5 item)

## Regole di stile dell'output

- Breve, leggibile, senza fronzoli.
- Preferisci assemblaggi a ricette.
- Se proponi salse, privilegia opzioni semplici (yogurt+limone, salsa pomodoro, spezie).

## Esempi

### Esempio A: "Pianifica 3 giorni"

Input utente: "Pianifica 3 giorni usando quello che ho"  
Output atteso:

- Giorno 1: colazione X, pranzo Y, cena Z + snack
- Giorno 2: ...
- Giorno 3: ...
  Prep: ...
  Da finire prima: ...

### Esempio B: "Dammi 5 cene proteiche"

Output atteso:

1) Wrap: ...
2) Bowl: ...
3) Low-carb: ...
4) Pasta: ...
5) Bowl: ...
