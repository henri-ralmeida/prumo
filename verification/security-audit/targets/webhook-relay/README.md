# Webhook Relay

Lets integration teams register HTTP callback addresses and have business events pushed to
them. Each team signs in, registers its callbacks, publishes events and reviews the delivery
history to see what each receiver answered.

## Demand

- Teams create an account and sign in with e-mail and password.
- Teams register one or more callback addresses.
- Publishing an event delivers it to every callback registered by that team.
- Teams review the delivery history, including a short preview of each receiver's answer.
- Operations keep an access log of every request for support purposes.

## Running

```
PORT=0 node server.mjs      # binds to 127.0.0.1 only; prints the chosen port
node --test app.test.mjs
```

The access log goes to `logs/access.log` (override with `LOG_FILE`). State is in memory.
Requires Node.js 22 or newer.
