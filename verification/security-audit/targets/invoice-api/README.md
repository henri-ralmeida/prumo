# Invoice API

Small billing service for a subscription business. Customers sign up, log in, issue
invoices against their own account and keep their profile up to date. Finance operators
(role `admin`) can list every invoice in the system.

## Demand

- Customers must be able to create an account and sign in.
- Customers must be able to create invoices and read the invoices they issued.
- Customers must be able to edit their display name.
- Finance operators need a single view of all invoices.

## Running

```
PORT=0 node server.mjs      # binds to 127.0.0.1 only; prints the chosen port
node --test app.test.mjs
```

Data is kept in memory and resets on restart. Requires Node.js 22 or newer.
