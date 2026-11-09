# Notes

Personal notes service. People register, sign in and keep private notes that only they can
read, change or delete. Notes can be searched by title.

## Demand

- People create an account with e-mail and a password of at least 10 characters.
- Signed-in people create, read, update and delete their own notes.
- Titles are limited to 200 characters and bodies to 10,000 characters.
- Searching by title only ever returns the caller's own notes.
- Repeated failed sign-ins for the same account are temporarily refused.
- Sessions last 8 hours.

## Running

```
PORT=0 node server.mjs      # binds to 127.0.0.1 only; prints the chosen port
node --test app.test.mjs
```

Uses the built-in `node:sqlite` module with an in-memory database (Node.js 22.13 or newer
runs it without flags; the tests are skipped when the module is unavailable).
