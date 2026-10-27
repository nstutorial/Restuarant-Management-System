# Hearth & Grain Restaurant Management

React/Vite client and Express API live in separate `client/` and `server/` folders. Prisma stores operational records in PostgreSQL. Keep the local `.env` private.

## Run locally

From the project root:

```powershell
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Open the Vite URL (normally `http://localhost:5173`). The API listens on port 4000; `http://localhost:4000/api/health` reports database connectivity. Create the first owner through the one-time setup screen. The seed upserts the demo branch, menu categories/items, and 12 tables.

## Connected workflows

- Authentication, branch membership, role permissions, and staff account activation.
- Database menu, availability, customer records, POS orders, order status, and kitchen tickets. Kitchen and order views refresh from the API periodically.
- Dining tables, table assignment, delivery details, delivery assignment and status history.
- Cash sessions, cash movements, cash tender/change, payment idempotency, bill records, and browser-printable receipts.
- Inventory ledger, manual adjustments, supplier records, purchase orders and receiving, expenses, branch tax settings, reports, and audit history.

The API stores these records in PostgreSQL. Run `npm run test:integration` against the configured development database to exercise key workflows. `npm run build` and `npm run build:server` build the client and API.

## Remaining limits

This is a database-backed development application, not a fully production-certified restaurant system. Tax is a configurable percentage estimate; it does not generate jurisdiction-compliant GST invoices. Payments record cash only; card/UPI gateway processing and refunds are not implemented. Inventory is tracked, but menu recipes do not automatically deduct ingredients when orders are placed. Kitchen and order refresh use polling rather than push events. Printing uses the browser print dialog and does not directly control receipt hardware. Offline operation, backups, deployment hardening, and operational review remain necessary before relying on it for live business.
