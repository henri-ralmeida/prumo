# Report Exporter

Internal service that lets the sales-operations team turn stored reports into files they can
open in a spreadsheet. A converter utility reformats the report data; operators pick the name
of the file they want and download it afterwards.

## Demand

- Operations staff list the reports available for export.
- Operations staff request an export of a report under a file name of their choice.
- Operations staff download the files they exported.
- Access is limited to callers presenting the shared service key from `config/settings.json`.

## Running

```
PORT=0 node server.mjs      # binds to 127.0.0.1 only; prints the chosen port
node --test app.test.mjs
```

Exported files go to `exports/` (or the directory given to `createApp`). Requires Node.js 22 or newer.
