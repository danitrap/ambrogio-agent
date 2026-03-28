---
name: ynab-daniele-budget
description: Use when the user asks about YNAB balances, spending, categories, payees, transactions, scheduled items, or monthly budget status for the budget named Daniele.
---

# YNAB Daniele Budget

## Use This Skill When
- The user asks questions about the YNAB budget named `Daniele`.
- The user wants spending analysis, balances, category status, payee lookups, or month summaries.
- The user asks to inspect transactions or scheduled transactions in YNAB.

## Do Not Use This Skill When
- The user is asking about a different budget.
- The user wants budget changes but has not stated the intended mutation clearly.

## Root Rule
- Always operate on the budget whose `name` is exactly `Daniele`.
- Resolve the budget ID first with:
```sh
npx -y @stephendolan/ynab-cli budgets list
```
- Extract the object where `name == "Daniele"` and pass its `id` through `-b <budget-id>` on all later commands.
- If zero or multiple budgets match `Daniele`, stop and report that budget resolution is ambiguous.

## Runtime Rule
- In this environment, prefer `npx -y @stephendolan/ynab-cli ...`.
- Do not use `bunx @stephendolan/ynab-cli ...` here because it currently fails during package execution.
- Authentication may come from `YNAB_API_KEY`; do not print the token.

## Default Posture
- Default to read-only analysis.
- Before any mutating command, require explicit user intent and restate the target object and exact change.
- Mutating commands include:
  - `transactions create`
  - `transactions update`
  - `transactions delete`
  - `transactions split`
  - `categories update`
  - `categories budget`
  - `payees update`
  - `scheduled delete`
  - `budgets set-default`

## Core Commands

### Budget Discovery
```sh
npx -y @stephendolan/ynab-cli budgets list
npx -y @stephendolan/ynab-cli budgets view <budget-id>
npx -y @stephendolan/ynab-cli budgets settings <budget-id>
```

### Accounts
```sh
npx -y @stephendolan/ynab-cli accounts list -b <budget-id>
npx -y @stephendolan/ynab-cli accounts view <account-id> -b <budget-id>
npx -y @stephendolan/ynab-cli accounts transactions <account-id> -b <budget-id>
```

### Categories
```sh
npx -y @stephendolan/ynab-cli categories list -b <budget-id>
npx -y @stephendolan/ynab-cli categories view <category-id> -b <budget-id>
npx -y @stephendolan/ynab-cli categories transactions <category-id> -b <budget-id>
```

### Transactions
```sh
npx -y @stephendolan/ynab-cli transactions list -b <budget-id>
npx -y @stephendolan/ynab-cli transactions search -b <budget-id> --memo "<text>"
npx -y @stephendolan/ynab-cli transactions search -b <budget-id> --payee-name "<name>"
npx -y @stephendolan/ynab-cli transactions view <transaction-id> -b <budget-id>
```

Useful filters:
- `--account <id>`
- `--category <id>`
- `--payee <id>`
- `--since <YYYY-MM-DD>`
- `--until <YYYY-MM-DD>`
- `--approved true|false`
- `--status cleared,uncleared,reconciled`
- `--min-amount <amount>`
- `--max-amount <amount>`
- `--fields id,date,amount,payee_name,category_name,memo`
- `--limit <number>`

### Payees
```sh
npx -y @stephendolan/ynab-cli payees list -b <budget-id>
npx -y @stephendolan/ynab-cli payees view <payee-id> -b <budget-id>
npx -y @stephendolan/ynab-cli payees transactions <payee-id> -b <budget-id>
```

### Months
```sh
npx -y @stephendolan/ynab-cli months list -b <budget-id>
npx -y @stephendolan/ynab-cli months view <YYYY-MM-01> -b <budget-id>
```

### Scheduled Transactions
```sh
npx -y @stephendolan/ynab-cli scheduled list -b <budget-id>
npx -y @stephendolan/ynab-cli scheduled view <scheduled-id> -b <budget-id>
```

## Query Patterns
- "Quanto ho speso da Amazon questo mese?":
  1. `transactions search --payee-name "Amazon" --since <first-day> --until <last-day>`
  2. Sum returned outflows if the user asked for a total.
- "Mostrami le spese in una categoria":
  1. `categories list -b <budget-id>`
  2. Resolve the category by exact or near-exact name.
  3. `categories transactions <category-id> -b <budget-id>`
- "Com'è messo il budget questo mese?":
  1. `months view <YYYY-MM-01> -b <budget-id>`
  2. Summarize budgeted, activity, available, overspent, and notable categories.
- "Quali pagamenti ricorrenti ho in arrivo?":
  1. `scheduled list -b <budget-id>`
  2. Sort or group by upcoming date and amount.
- "Che saldo hanno i conti?":
  1. `accounts list -b <budget-id>`
  2. Summarize by account type and current balance.

## Interpretation Rules
- The CLI returns JSON by default. Prefer direct JSON inspection over prose assumptions.
- Amounts are in currency units, not milliunits.
- Treat negative transaction amounts as outflows and positive amounts as inflows unless the returned object indicates otherwise.
- When a user asks for "this month", "last month", or similar, translate that into explicit dates in `Europe/Rome`.
- If the user asks for a total, show the date window and what you counted.
- If the result set is large, narrow it with filters before summarizing.

## Output Contract
- Answer the budget question in natural language first.
- Include key figures, date range, and any filters applied.
- When useful, include short tables or bullet lists of top categories, top payees, or recent transactions.
- If the user explicitly asks for raw output, provide the relevant JSON excerpt or summarize the returned objects faithfully.

## Guardrails
- Never invent category IDs, account IDs, or totals.
- Never expose `YNAB_API_KEY`.
- Never switch to another budget silently.
- If a mutation is requested, confirm the exact target and change before running it.
