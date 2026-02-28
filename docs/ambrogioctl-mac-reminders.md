# ambrogioctl mac reminders

Operational reference for Apple Reminders through the mac tools service.

## Tag model

Canonical GTD tags:
- `#next`
- `#waiting`
- `#someday`
- `#tickler`
- `#personal`
- `#work`
- `#home`

Legacy `@tag` input is accepted, but output is normalized to `#tag`.

Each reminder should ideally have:
- exactly 1 status tag
- at most 1 area tag

Ambrogio-managed reminder writes store managed tags in a single notes line:

```text
ambrogio-tags: #next #personal
```

## Read open reminders

```bash
ambrogioctl mac reminders open --json
```

Optional filters:

```bash
ambrogioctl mac reminders open --tag #next --json
ambrogioctl mac reminders open --list "Promemoria" --json
ambrogioctl mac reminders open --tag #waiting --list "Inbox" --json
ambrogioctl mac reminders open --include-no-due-date false --json
```

Returned reminder fields include:
- `tags`
- `statusTag`
- `areaTag`
- `otherTags`
- `notesFull`
- `dueAt`
- `dueInMinutes`
- `isOverdue`

`notesFull` is always included. There is no `notesPreview`.

## Weekly review / completed reminders

Default last 7 days:

```bash
ambrogioctl mac reminders open --state completed --json
```

Custom window:

```bash
ambrogioctl mac reminders open --state completed --days 14 --json
```

## Create reminders

Example:

```bash
ambrogioctl mac reminders create \
  --list "Inbox" \
  --title "Contattare Gian Marco" \
  --status-tag #next \
  --area-tag #personal \
  --tags "#calls,#people" \
  --notes "Chiedere aggiornamento onboarding" \
  --json
```

With due date:

```bash
ambrogioctl mac reminders create \
  --list "Inbox" \
  --title "Gift card Decathlon" \
  --due "2026-03-03T09:00:00+01:00" \
  --status-tag #tickler \
  --area-tag #personal \
  --json
```

## Update reminders

Mark as waiting:

```bash
ambrogioctl mac reminders update --id <reminder-id> --status-tag #waiting --json
```

Reschedule:

```bash
ambrogioctl mac reminders update \
  --id <reminder-id> \
  --due "2026-03-10T09:00:00+01:00" \
  --json
```

Clear due date and managed area/status tags:

```bash
ambrogioctl mac reminders update \
  --id <reminder-id> \
  --due none \
  --status-tag none \
  --area-tag none \
  --json
```

## Troubleshooting

If Reminders access is denied:
1. Open `System Settings > Privacy & Security > Reminders`
2. Enable access for the terminal or host process running Ambrogio
3. Retry:

```bash
ambrogioctl mac info --json
ambrogioctl mac reminders open --json
```
