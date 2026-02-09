---
name: meal-planning
description: Pianifica pasti usando la dispensa/frigo in /data/groceries.md. Applica la filosofia a building blocks (proteina + carbo + fibre + grassi opzionali), genera un piano pratico e memorizza obiettivi macros e preferenze utente.
---

# Meal Planning Skill

## Scopo

Generare piani pasto (giornalieri o settimanali) basati esclusivamente su cio che l'utente ha gia in casa, seguendo un approccio modulare a building blocks. Memorizza obiettivi nutrizionali e traccia suggerimenti recenti per evitare ripetizioni.

Fonte inventario: `/data/groceries.md`  
Nota: la lettura/scrittura del file e gestita da un'altra skill gia presente. Questa skill deve delegare accesso al file e lavorare sui contenuti.

## Stato Persistente

La skill utilizza `ambrogioctl state` per memorizzare:

- **Obiettivi macros**: `meal-planning:macros:goals`
- **Cronologia suggerimenti**: `meal-planning:recent:suggestions`
- **Preferenze utente**: `meal-planning:preferences:diet`, `meal-planning:preferences:allergies`

## Gestione Obiettivi Macros

### Leggere Obiettivi Correnti

```bash
get_macros_goals() {
  local goals=$(ambrogioctl state get "meal-planning:macros:goals" 2>/dev/null | cut -d= -f2-)
  
  if [[ -n "$goals" ]]; then
    local calories=$(echo "$goals" | grep -o '"calories":[0-9]*' | cut -d':' -f2)
    local protein=$(echo "$goals" | grep -o '"protein_g":[0-9]*' | cut -d':' -f2)
    local carbs=$(echo "$goals" | grep -o '"carbs_g":[0-9]*' | cut -d':' -f2)
    local fats=$(echo "$goals" | grep -o '"fats_g":[0-9]*' | cut -d':' -f2)
    local updated=$(echo "$goals" | grep -o '"updated_at":"[^"]*"' | cut -d'"' -f4)
    
    echo "Obiettivi macros (aggiornati: $updated):"
    echo "  Calorie: $calories kcal"
    echo "  Proteine: ${protein}g"
    echo "  Carboidrati: ${carbs}g"
    echo "  Grassi: ${fats}g"
  else
    echo "Nessun obiettivo macros configurato."
    echo "Suggerimento: 2000 kcal | 150g proteine | 200g carboidrati | 70g grassi"
  fi
}
```

### Salvare/Aggiornare Obiettivi

```bash
set_macros_goals() {
  local calories="${1:-2000}"
  local protein="${2:-150}"
  local carbs="${3:-200}"
  local fats="${4:-70}"
  
  local goals_json="{\"calories\":$calories,\"protein_g\":$protein,\"carbs_g\":$carbs,\"fats_g\":$fats,\"updated_at\":\"$(date -Iseconds)\"}"
  
  ambrogioctl state set "meal-planning:macros:goals" "$goals_json"
  echo "Obiettivi macros salvati: ${calories}kcal | ${protein}g P | ${carbs}g C | ${fats}g F"
}

# Esempio uso
# set_macros_goals 2200 180 220 65  # Bulk
# set_macros_goals 1800 140 150 60  # Cut
```

### Calcolare Macros per Pasto

```bash
calculate_meal_macros() {
  local meals_per_day="${1:-3}"
  local snacks="${2:-1}"
  
  local goals=$(ambrogioctl state get "meal-planning:macros:goals" 2>/dev/null | cut -d= -f2-)
  
  if [[ -z "$goals" ]]; then
    echo "Nessun obiettivo macros configurato."
    return 1
  fi
  
  local calories=$(echo "$goals" | grep -o '"calories":[0-9]*' | cut -d':' -f2)
  local protein=$(echo "$goals" | grep -o '"protein_g":[0-9]*' | cut -d':' -f2)
  local carbs=$(echo "$goals" | grep -o '"carbs_g":[0-9]*' | cut -d':' -f2)
  local fats=$(echo "$goals" | grep -o '"fats_g":[0-9]*' | cut -d':' -f2)
  
  # Distribuzione: 30% pranzo, 30% cena, 25% colazione, 15% snack
  echo "Distribuzione macros per ${meals_per_day} pasti principali + ${snacks} snack:"
  echo ""
  echo "Pranzo/Cena (~30% ciascuno):"
  echo "  ~$(( calories * 30 / 100 )) kcal | $(( protein * 30 / 100 ))g P | $(( carbs * 30 / 100 ))g C | $(( fats * 30 / 100 ))g F"
  echo ""
  echo "Colazione (~25%):"
  echo "  ~$(( calories * 25 / 100 )) kcal | $(( protein * 25 / 100 ))g P | $(( carbs * 25 / 100 ))g C | $(( fats * 25 / 100 ))g F"
  echo ""
  echo "Snack (~15%):"
  echo "  ~$(( calories * 15 / 100 )) kcal | $(( protein * 15 / 100 ))g P | $(( carbs * 15 / 100 ))g C | $(( fats * 15 / 100 ))g F"
}
```

## Tracking Suggerimenti Recenti

Evita di suggerire gli stessi pasti troppo frequentemente:

### Registrare un Suggerimento

```bash
record_suggestion() {
  local meal_description="$1"
  local max_history=7
  
  # Crea hash del pasto (primi 50 char)
  local meal_hash=$(echo -n "${meal_description:0:50}" | sha256sum | cut -d' ' -f1 | cut -c1-16)
  local now=$(date -Iseconds)
  
  # Ottieni cronologia esistente
  local history=$(ambrogioctl state get "meal-planning:recent:suggestions" 2>/dev/null | cut -d= -f2-)
  
  if [[ -z "$history" ]]; then
    # Prima entry
    local new_history="[{\"hash\":\"$meal_hash\",\"description\":\"${meal_description:0:100}\",\"suggested_at\":\"$now\"}]"
  else
    # Aggiungi nuovo elemento e mantieni solo gli ultimi N
    local new_entry="{\"hash\":\"$meal_hash\",\"description\":\"${meal_description:0:100}\",\"suggested_at\":\"$now\"}"
    # Usa jq se disponibile, altrimenti append semplice
    if command -v jq >/dev/null 2>&1; then
      new_history=$(echo "$history" | jq --arg entry "$new_entry" '. + [$entry | fromjson] | last('$max_history')')
    else
      # Fallback: sovrascrivi con nuovo array contenente solo l'ultimo
      new_history="[$new_entry]"
    fi
  fi
  
  ambrogioctl state set "meal-planning:recent:suggestions" "$new_history"
}
```

### Verificare Duplicati Recenti

```bash
is_recently_suggested() {
  local meal_description="$1"
  local meal_hash=$(echo -n "${meal_description:0:50}" | sha256sum | cut -d' ' -f1 | cut -c1-16)
  
  local history=$(ambrogioctl state get "meal-planning:recent:suggestions" 2>/dev/null | cut -d= -f2-)
  
  if [[ -n "$history" ]]; then
    # Controlla se l'hash esiste nella cronologia
    if echo "$history" | grep -q "\"hash\":\"$meal_hash\""; then
      return 0  # Trovato (recente)
    fi
  fi
  
  return 1  # Non trovato (ok suggerire)
}

# Esempio uso in workflow
suggest_meal() {
  local meal="$1"
  
  if is_recently_suggested "$meal"; then
    echo "SKIP: '$meal' suggerito recentemente"
    return 1
  fi
  
  # Suggerisci e registra
  echo "Suggerisco: $meal"
  record_suggestion "$meal"
}
```

### Ottenere Cronologia Completa

```bash
get_recent_suggestions() {
  local history=$(ambrogioctl state get "meal-planning:recent:suggestions" 2>/dev/null | cut -d= -f2-)
  
  if [[ -n "$history" ]]; then
    echo "Ultimi pasti suggeriti:"
    echo "$history" | jq -r '.[] | "  - \(.description) (\(.suggested_at | split("T")[0]))"' 2>/dev/null || echo "$history"
  else
    echo "Nessun pasto recente in cronologia."
  fi
}
```

## Gestione Preferenze Utente

```bash
# Chiavi preferenze
# meal-planning:preferences:diet - tipo di dieta (omnivoro, vegetariano, vegano, keto, etc)
# meal-planning:preferences:allergies - allergie/intolleranze (JSON array)
# meal-planning:preferences:disliked - cibi da evitare (JSON array)

set_dietary_preference() {
  local diet="$1"  # omnivoro, vegetariano, vegano, keto, paleo, etc
  ambrogioctl state set "meal-planning:preferences:diet" "{\"type\":\"$diet\",\"updated_at\":\"$(date -Iseconds)\"}"
  echo "Preferenza dieta aggiornata: $diet"
}

add_allergy() {
  local allergy="$1"
  local current=$(ambrogioctl state get "meal-planning:preferences:allergies" 2>/dev/null | cut -d= -f2-)
  
  if [[ -z "$current" ]]; then
    local new_list="[\"$allergy\"]"
  else
    # Aggiungi se non esiste
    if ! echo "$current" | grep -qi "\"$allergy\""; then
      local new_list=$(echo "$current" | jq --arg a "$allergy" '. + [$a]')
    else
      local new_list="$current"
    fi
  fi
  
  ambrogioctl state set "meal-planning:preferences:allergies" "$new_list"
  echo "Allergy aggiunta: $allergy"
}

get_dietary_restrictions() {
  local diet=$(ambrogioctl state get "meal-planning:preferences:diet" 2>/dev/null | cut -d= -f2-)
  local allergies=$(ambrogioctl state get "meal-planning:preferences:allergies" 2>/dev/null | cut -d= -f2-)
  
  if [[ -n "$diet" ]]; then
    local diet_type=$(echo "$diet" | grep -o '"type":"[^"]*"' | cut -d'"' -f4)
    echo "Dieta: $diet_type"
  fi
  
  if [[ -n "$allergies" ]]; then
    echo "Allergie: $allergies"
  fi
}
```

## Quando usare questa skill

Usa questa skill quando l'utente chiede:

- Pianificazione pasti / menu settimanale
- Idee pasti basate su quello che c'e in casa
- Combinazioni "proteiche" o "macro-friendly" con ingredienti disponibili
- "Svuotare frigo/dispensa" o ridurre sprechi
- Impostare/modificare obiettivi macros
- Vedere cronologia pasti suggeriti

## Quando NON usarla

- Se l'utente chiede ricette dettagliate stile food blog (in quel caso: generare 1 ricetta specifica, non un piano).
- Se l'utente chiede una lista della spesa (in quel caso: proponi lista spesa solo come output secondario e minimale, se mancano 1-2 ingredienti critici).

## Input che questa skill dovrebbe accettare

- Orizzonte: `oggi`, `2 giorni`, `settimana`, `N pasti`
- Vincoli: "no cucinare a pranzo", "solo air fryer", "poche stoviglie", "pasti veloci"
- Preferenze: building blocks preferiti, ingredienti da finire presto, avversioni
- (Opzionale) Macro target giornalieri o per pasto
- Comandi di gestione: "imposta macros", "mostra obiettivi", "cronologia pasti"

Se mancano dettagli, applica default ragionevoli:

- 2 pasti principali + 1 snack
- Ripetizione intelligente (massimo 2 volte lo stesso pasto nella settimana)
- Priorita a ingredienti deperibili
- Se obiettivi macros sono configurati, usa quelli; altrimenti suggerisci valori standard

## Procedura

1) **Controlla obiettivi macros**: `ambrogioctl state get meal-planning:macros:goals`
   - Se l'utente ha obiettivi configurati, usa quelli
   - Se non ci sono, suggerisci valori di default e chiedi se vuole impostarli

2) **Controlla preferenze dietetiche**: `ambrogioctl state get meal-planning:preferences:diet`
   - Applica restrizioni (vegetariano, allergie, etc.)

3) **Leggi cronologia suggerimenti**: `ambrogioctl state get meal-planning:recent:suggestions`
   - Evita di ripetere pasti suggeriti negli ultimi 7 giorni

4) Leggi l'inventario chiamando la skill esistente che restituisce il contenuto di `/data/groceries.md`.

5) Parsa e normalizza gli item:
   - Uniforma nomi (es. "yogurt greco 0%" = yogurt greco)
   - Se ci sono quantita, conservale; se mancano, assumi quantita non note
   - Se ci sono note tipo "da finire", "scade", "aperto", trattale come priorita

6) Classifica ogni item in categorie:
   - Proteine (carni, pesce, uova, latticini proteici, legumi, tofu/seitan)
   - Carbo (riso, pasta, pane, tortillas, patate, avena)
   - Fibre/verdure (verdure, insalate, legumi se usati come "volume")
   - Grassi/condimenti (olio evo, frutta secca, burro d'arachidi, formaggi grassi)
   - Extra (salse, spezie, dolci, snack)

7) Costruisci un set di combo base (building blocks):
   - Template Bowl: proteina + carbo + verdura + condimento
   - Template Wrap: tortilla/pane + proteina + salsa/verdura
   - Template Pasta/Riso: carbo + proteina + sugo/verdura
   - Template Low-carb: proteina + verdura + grassi misurati
   Ogni combo deve usare solo ingredienti presenti (o al massimo 1 micro-eccezione tipo limone/spezie, se plausibile).
   - Verifica che il pasto non sia in `meal-planning:recent:suggestions`

8) Assembla il piano:
   - Distribuisci proteine lungo la settimana
   - Non ripetere identico nello stesso giorno
   - Usa prima cio che e piu deperibile (se indicato nel file)
   - Se obiettivi macros sono configurati, calcola distribuzione per pasto
   - Registra ogni suggerimento in `meal-planning:recent:suggestions`

9) Output chiaro e operativo:
   - Piano giorno per giorno (colazione/pranzo/cena/snack) O elenco di N pasti pronti
   - Macros stimati per pasto (se obiettivi configurati)
   - Prep in batch suggerito (es. cuoci 400g pollo e 2 porzioni riso)
   - Da finire prima (2-5 item)
   - (Opzionale) Mini lista spesa solo se serve per sbloccare 80% dei pasti (max 5 item)

## Regole di stile dell'output

- Breve, leggibile, senza fronzoli.
- Preferisci assemblaggi a ricette.
- Se proponi salse, privilegia opzioni semplici (yogurt+limone, salsa pomodoro, spezie).
- Se obiettivi macros sono configurati, includi stima macros per ogni pasto suggerito.

## Comandi di Gestione

```bash
# Imposta obiettivi macros
ambrogioctl state set meal-planning:macros:goals '{"calories":2200,"protein_g":180,"carbs_g":220,"fats_g":65,"updated_at":"'$(date -Iseconds)'"}'

# Mostra obiettivi
echo "Obiettivi macros:" && ambrogioctl state get meal-planning:macros:goals | cut -d= -f2- | jq .

# Mostra cronologia pasti
echo "Cronologia:" && ambrogioctl state get meal-planning:recent:suggestions | cut -d= -f2- | jq '.[] | .description'

# Imposta preferenza dieta
ambrogioctl state set meal-planning:preferences:diet '{"type":"vegetariano","updated_at":"'$(date -Iseconds)'"}'

# Lista tutti i dati meal-planning
ambrogioctl state list --pattern "meal-planning:*"
```

## Esempi

### Esempio A: "Pianifica 3 giorni"

Input utente: "Pianifica 3 giorni usando quello che ho"  
Output atteso:

```
Obiettivi macros: 2000 kcal | 150g P | 200g C | 70g F

Giorno 1:
- Colazione: Yogurt greco + avena + mirtilli (~450 kcal | 30g P | 60g C | 10g F)
- Pranzo: Bowl riso + pollo + verdure miste (~600 kcal | 45g P | 70g C | 15g F)
- Cena: Wrap uova + spinaci + formetta (~550 kcal | 35g P | 50g C | 20g F)
- Snack: Frutta secca + frutta (~400 kcal | 10g P | 20g C | 25g F)

Giorno 2: ...
Giorno 3: ...

Prep batch: cuoci 400g pollo, 300g riso
Da finire prima: pomodori (scadono tra 2gg), yogurt (aperto)
```

### Esempio B: "Dammi 5 cene proteiche"

Output atteso:

```
1) Bowl: riso + tonno + avocado + cetrioli (~550 kcal | 40g P)
2) Wrap: tortilla + tacchino + hummus + pomodori (~480 kcal | 35g P)
3) Low-carb: salmone + asparagi + olio EVO (~450 kcal | 38g P)
4) Pasta: integrale + sugo tonno + capperi (~620 kcal | 32g P)
5) Bowl: quinoa + ceci + feta + olive (~520 kcal | 20g P)

Tutti i pasti rispettano obiettivi macros configurati.
Nessuno di questi è stato suggerito negli ultimi 7 giorni.
```

### Esempio C: "Imposta i miei macros"

Input utente: "Voglio impostare 2500 calorie con 200g proteine"  
Azione:
```bash
# Calcola C e F rimanenti (split 50/30/20)
carbs=$(( 2500 * 50 / 100 / 4 ))  # 4 kcal/g
carbs=$(( 2500 * 30 / 100 / 4 ))  # 4 kcal/g  
fats=$(( 2500 * 20 / 100 / 9 ))   # 9 kcal/g

ambrogioctl state set meal-planning:macros:goals \
  '{"calories":2500,"protein_g":200,"carbs_g":'$carbs',"fats_g":'$fats',"updated_at":"'$(date -Iseconds)'"}'
```

Output: "Obiettivi macros salvati: 2500kcal | 200g P | 312g C | 55g F"
