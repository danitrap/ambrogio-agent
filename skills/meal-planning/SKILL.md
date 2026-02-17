---
name: meal-planning
description: Plan practical meals from pantry inventory using a building-block approach (protein + carbs + fiber + optional fats) with macro/preference memory.
---

# Meal Planning

## Use This Skill When
- The user asks for daily/weekly meal ideas from available ingredients.
- The user asks to set or apply macro goals/preferences.

## Do Not Use This Skill When
- Inventory is unavailable and the user refuses assumptions.

## Inputs
- Inventory source: `/data/groceries.md`.
- Optional: calories/macros goals, dietary preferences, allergies.

## Workflow
1. Read available ingredients from grocery/pantry state.
2. Build meals using blocks:
- protein
- carbs
- fiber/vegetables
- optional fats
3. Match plan to user goals/preferences.
4. Avoid recent repeats via state history.
5. Return a practical plan (meal + short prep idea).

## Persistent State Keys
- `meal-planning:macros:goals`
- `meal-planning:preferences:diet`
- `meal-planning:preferences:allergies`
- `meal-planning:recent:suggestions`

## Output Contract
- Provide concrete meals, not generic nutrition theory.
- Explicitly mark substitutions when ingredients are missing.
- If goals are unknown, ask once or use conservative defaults and declare them.

## Guardrails
- Respect allergies and dietary restrictions strictly.
- Do not claim medical advice.
- Keep suggestions realistic with available ingredients.
