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


## Separate customer portal

The customer portal has its own Vite app in `apps/customer` and its own standalone deployment config in `vercel.customer.json`. It uses customer-only registration/login sessions and writes delivery orders into the same PostgreSQL database as staff Orders and Kitchen. Customers can browse the menu before signing in; checkout requires an account, and signed-in customers can review their order history. Registration and login are available from the customer site. Share the customer deployment URL, not the staff site URL.

Run locally with `npm run dev:customer` (port 5174), or make a customer production bundle with `npm run build:customer`. The default local Vite proxy sends `/api` calls to `localhost:4000`; registration and login are linked from the standalone customer sign-in screen. For a separate Vercel project, set the project Root Directory to the repository root, set the Build Command to `npm run build:customer:vercel`, Output Directory to `dist/customer`, and install command to `npm install && npm run db:generate`. Add rewrites for `/api/(.*)` to the shared API function and `/customer/(.*)` to `/index.html`; use the same `DATABASE_URL` and `DEMO_BRANCH_ID` as the staff project. Set `VITE_API_BASE` to the API origin (for example, `https://api.example.com`) when the customer site and API are on different origins. Configure the API environment variable `CUSTOMER_PORTAL_ORIGIN` to the exact customer-site origin (scheme and host); customer session cookies are HTTP-only and use `SameSite=None; Secure` in production. If the two deployments use unrelated domains, browser third-party cookie policies may block sessions; use customer and API subdomains under the same registrable domain or host `/api` behind the customer domain.

Apply the new customer account/session and delivery-distance schema before deploying with `npm run db:deploy` (or `npm run db:migrate` in development). The portal has indexed customer-order history, bounded page size, hashed passwords, expiring/revocable sessions, and basic IP-based login throttling. Handling 2,000 daily visitors also depends on the hosting plan, database connection limits/pooling, backups and monitoring; use the production database pooler and verify your provider limits before public launch.


Customer delivery locations use browser geolocation when the customer chooses “Use current location”; the interactive map supports tap-to-place and draggable pins. Address search/reverse lookup uses the configured geocoder default, road distance uses a routed driving estimate, and the selected point can be opened in Google Maps. Guest carts are stored in browser local storage; signed-in carts are saved on the customer account. For higher production volume, configure a commercial geocoding/routing provider and review its quotas, privacy terms, and billing before launch.
