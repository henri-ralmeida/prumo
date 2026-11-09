# Coupon Checkout

Backend for a small online shop: product catalogue with free-text search, a checkout that
accepts promotional coupons, and order lookup. A partner storefront also submits carts and
may send its own negotiated unit prices.

## Demand

- Shoppers search the catalogue by product name.
- Shoppers check out a cart; stock is reduced and an order is stored.
- A coupon gives a percentage discount; each coupon has a limited number of uses.
- Partner storefronts may include a negotiated unit price per cart line.
- A shopper looks an order up by order number plus the e-mail used at checkout.

## Running

```
PORT=0 node server.mjs      # binds to 127.0.0.1 only; prints the chosen port
node --test app.test.mjs
```

Uses the built-in `node:sqlite` module with an in-memory database (Node.js 22.13 or newer
runs it without flags; the tests are skipped when the module is unavailable).
