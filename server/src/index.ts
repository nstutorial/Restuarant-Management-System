import express from 'express';
import 'dotenv/config';
import { PrismaClient, Prisma, OrderStatus, OrderType, PaymentMethod, PaymentStatus, StaffRole } from '@prisma/client';
import { z } from 'zod';
import { compare, hash } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const app = express();
const port = Number(process.env.PORT ?? 4000);
// Prisma's default pool is based on CPU count (2 * CPUs + 1). On a single
// restaurant server this can open far more Neon connections than the app needs.
if (process.env.DATABASE_URL) {
  try {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    databaseUrl.searchParams.set('connection_limit', databaseUrl.searchParams.get('connection_limit') ?? '5');
    databaseUrl.searchParams.set('pool_timeout', databaseUrl.searchParams.get('pool_timeout') ?? '10');
    databaseUrl.searchParams.set('connect_timeout', databaseUrl.searchParams.get('connect_timeout') ?? '10');
    process.env.DATABASE_URL = databaseUrl.toString();
  } catch { /* Prisma will report malformed database URLs on first use. */ }
}
// Uses the standard PostgreSQL connection URL from DATABASE_URL; regenerate this client after schema changes.
const prisma = new PrismaClient();
const moneyText = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
const orderTax = (lines: Array<{ lineTotal: Prisma.Decimal; taxRate: Prisma.Decimal }>, discount: Prisma.Decimal, deliveryFee: Prisma.Decimal, defaultRate: Prisma.Decimal) => {
  const subtotal = lines.reduce((sum, line) => sum.add(line.lineTotal), new Prisma.Decimal(0));
  const lineTax = lines.reduce((sum, line) => {
    const discountShare = subtotal.gt(0) ? discount.mul(line.lineTotal).div(subtotal) : new Prisma.Decimal(0);
    const taxable = line.lineTotal.sub(discountShare).add(new Prisma.Decimal(0));
    return sum.add(taxable.mul(line.taxRate).div(100).toDecimalPlaces(2));
  }, new Prisma.Decimal(0));
  return lineTax.add(deliveryFee.mul(defaultRate).div(100).toDecimalPlaces(2));
};
type Permission = 'menu.read' | 'orders.read' | 'orders.create' | 'orders.status.update' | 'payments.create' | 'tables.read' | 'tables.update' | 'customers.read' | 'customers.manage' | 'kitchen.read' | 'delivery.read' | 'inventory.read' | 'inventory.manage' | 'suppliers.read' | 'suppliers.manage' | 'purchases.read' | 'purchases.manage' | 'expenses.read' | 'expenses.manage' | 'cash.read' | 'cash.manage' | 'reports.read' | 'staff.manage' | 'settings.manage' | 'audit.read';
type AuthContext = { sessionId: string; user: { id: string; name: string; email: string }; memberships: Array<{ branchId: string; branchName: string; role: StaffRole }> };
type AuthRequest = Request & { auth?: AuthContext };
const allPermissions: Permission[] = ['menu.read','orders.read','orders.create','orders.status.update','payments.create','tables.read','tables.update','customers.read','customers.manage','kitchen.read','delivery.read','inventory.read','inventory.manage','suppliers.read','suppliers.manage','purchases.read','purchases.manage','expenses.read','expenses.manage','cash.read','cash.manage','reports.read','staff.manage','settings.manage','audit.read'];
const rolePermissions: Record<StaffRole, Permission[]> = {
  OWNER: allPermissions,
  MANAGER: allPermissions.filter(p => p !== 'audit.read'),
  CASHIER: ['menu.read','orders.read','orders.create','payments.create','tables.read','tables.update','customers.read','customers.manage','cash.read','cash.manage'],
  WAITER: ['menu.read','orders.read','orders.create','tables.read','tables.update','customers.read'],
  KITCHEN: ['orders.read','orders.status.update','kitchen.read'],
  DELIVERY: ['orders.read','orders.status.update','delivery.read'],
  INVENTORY: ['inventory.read','inventory.manage','suppliers.read','suppliers.manage','purchases.read','purchases.manage','menu.read'],
  ACCOUNTANT: ['orders.read','inventory.read','suppliers.read','purchases.read','purchases.manage','expenses.read','expenses.manage','cash.read','reports.read'],
};
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const branchEventStreams = new Map<string, Set<Response>>();
const sessionLifetimeMs = 30 * 24 * 60 * 60_000;
const sessionRefreshWindowMs = 7 * 24 * 60 * 60_000;
const customerSessionLifetimeMs = 30 * 24 * 60 * 60_000;
// Browsers reject SameSite=None cookies without Secure. The local customer
// portal and API share the localhost site through Vite, so Lax works in dev;
// deployed cross-site portals need None + Secure.
const customerSessionCookie = (token: string, maxAge = Math.floor(customerSessionLifetimeMs / 1000)) => `customer_session=${encodeURIComponent(token)}; HttpOnly; SameSite=${process.env.NODE_ENV === 'production' ? 'None' : 'Lax'}; Path=/api/customer; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
const customerEventStreams = new Map<string, Set<Response>>();
function publishCustomerEvent(customerId: string, event: string, data: Record<string, unknown> = {}) {
  const streams = customerEventStreams.get(customerId);
  if (!streams) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const stream of streams) stream.write(payload);
}
type CustomerAuthRequest = Request & { customerAuth?: { accountId: string; customerId: string; name: string; email: string; phone: string | null } };
async function requireCustomerSession(request: Request, response: Response, next: NextFunction) {
  const token = cookieValue(request, 'customer_session');
  if (!token) return response.status(401).json({ error: { message: 'Sign in to continue.' } });
  try {
    const session = await prisma.customerPortalSession.findUnique({ where: { tokenHash: tokenDigest(token) }, include: { account: { include: { customer: true } } } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.account.active) return response.status(401).json({ error: { message: 'Your customer session expired. Sign in again.' } });
    if (session.expiresAt.getTime() - Date.now() < 7 * 24 * 60 * 60_000) {
      const expiresAt = new Date(Date.now() + customerSessionLifetimeMs);
      await prisma.customerPortalSession.update({ where: { id: session.id }, data: { expiresAt } });
      response.setHeader('Set-Cookie', customerSessionCookie(token));
    }
    (request as CustomerAuthRequest).customerAuth = { accountId: session.account.id, customerId: session.account.customerId, name: session.account.customer.name, email: session.account.email, phone: session.account.customer.phone };
    next();
  } catch (error) { next(error); }
}

function publishBranchEvent(branchId: string, event: string, data: Record<string, unknown> = {}) {
  const streams = branchEventStreams.get(branchId);
  if (!streams) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const stream of streams) stream.write(payload);
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.cookie ?? '';
  const pair = header.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : undefined;
}
function tokenDigest(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function sessionCookie(token: string, maxAgeSeconds = Math.floor(sessionLifetimeMs / 1000)) {
  return `restaurant_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
function sameOrigin(request: Request): boolean {
  const origin = request.get('origin');
  if (!origin) return false;
  const allowed = process.env.CLIENT_ORIGIN;
  if (allowed && origin === allowed) return true;
  // In development, Vite proxies same-origin browser calls to Express on port 4000.
  // The browser Origin remains localhost:5173 while Express sees localhost:4000.
  if (process.env.NODE_ENV !== 'production') {
    try {
      const requestOrigin = new URL(origin);
      const requestHost = request.get('x-forwarded-host')?.split(',')[0]?.trim() ?? request.get('host');
      if (requestOrigin.origin === 'http://localhost:5173' && requestHost === 'localhost:4000') return true;
      if (requestOrigin.origin === 'http://127.0.0.1:5173' && requestHost === '127.0.0.1:4000') return true;
      if (requestOrigin.origin === 'http://localhost:5174' && requestHost === 'localhost:4000') return true;
      if (requestOrigin.origin === 'http://127.0.0.1:5174' && (requestHost === '127.0.0.1:4000' || requestHost === 'localhost:4000')) return true;
    } catch { /* Reject malformed origins below. */ }
  }
  try {
    const requestOrigin = new URL(origin);
    const forwardedHost = request.get('x-forwarded-host');
    const requestHost = forwardedHost?.split(',')[0]?.trim() ?? request.get('host');
    const forwardedProto = request.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const expectedProtocol = forwardedProto ? `${forwardedProto}:` : request.protocol;
    return Boolean(requestHost && requestOrigin.host === requestHost && requestOrigin.protocol === expectedProtocol);
  } catch {
    return false;
  }
}
function requireSameOrigin(request: Request, response: Response, next: NextFunction) {
  if (!sameOrigin(request)) return response.status(403).json({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Request origin was not accepted.' } });
  next();
}
async function requireSession(request: Request, response: Response, next: NextFunction) {
  const token = cookieValue(request, 'restaurant_session');
  if (!token) return response.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
  try {
    const session = await prisma.session.findUnique({ where: { tokenHash: tokenDigest(token) }, include: { user: { include: { memberships: { where: { active: true }, include: { branch: true } } } } } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.active) return response.status(401).json({ error: { code: 'SESSION_EXPIRED', message: 'Sign in again to continue.' } });
    if (session.expiresAt.getTime() - Date.now() < sessionRefreshWindowMs) {
      const expiresAt = new Date(Date.now() + sessionLifetimeMs);
      await prisma.session.update({ where: { id: session.id }, data: { expiresAt } });
      response.setHeader('Set-Cookie', sessionCookie(token));
    }
    (request as AuthRequest).auth = { sessionId: session.id, user: { id: session.user.id, name: session.user.name, email: session.user.email }, memberships: session.user.memberships.map(m => ({ branchId: m.branchId, branchName: m.branch.name, role: m.role })) };
    next();
  } catch (error) { next(error); }
}
function branchMembership(request: Request, branchId: string) {
  return (request as AuthRequest).auth?.memberships.find(m => m.branchId === branchId);
}
function requireBranchPermission(permission: Permission) {
  return (request: Request, response: Response, next: NextFunction) => {
    const branchId = String(request.query.branchId ?? (request.body as { branchId?: string })?.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
    const membership = branchMembership(request, branchId);
    if (!membership) return response.status(403).json({ error: { code: 'BRANCH_FORBIDDEN', message: 'You do not have access to this branch.' } });
    if (!rolePermissions[membership.role].includes(permission)) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have permission for this action.' } });
    next();
  };
}

app.disable('x-powered-by');
app.use((request, response, next) => {
  const allowedOrigin = process.env.CUSTOMER_PORTAL_ORIGIN;
  const origin = request.get('origin');
  if (allowedOrigin && origin === allowedOrigin) {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    if (request.method === 'OPTIONS') return response.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '3mb' }));

app.get('/api/events', requireSession, (request, response) => {
  const branchId = String(request.query.branchId ?? '');
  const membership = branchMembership(request, branchId);
  if (!membership || !rolePermissions[membership.role].some(permission => ['tables.read', 'orders.read', 'kitchen.read'].includes(permission))) {
    return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have access to live updates for this branch.' } });
  }
  response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  response.flushHeaders();
  response.write('retry: 3000\nevent: connected\ndata: {}\n\n');
  const streams = branchEventStreams.get(branchId) ?? new Set<Response>();
  streams.add(response);
  branchEventStreams.set(branchId, streams);
  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 25000);
  request.on('close', () => {
    clearInterval(heartbeat);
    streams.delete(response);
    if (!streams.size) branchEventStreams.delete(branchId);
  });
});

app.get('/api/health', async (_request, response) => {
  try {
    await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
    response.json({ status: 'ok', database: 'connected', service: 'restaurant-management-api' });
  } catch {
    response.status(503).json({ status: 'degraded', database: 'disconnected', service: 'restaurant-management-api' });
  }
});

// Public customer menu and referrer-restricted browser map key for the shareable /order storefront.
app.get('/api/public/storefront', async (request, response, next) => {
  const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
  try {
    const branch = await prisma.branch.findUnique({ where: { id: branchId }, include: { restaurant: true, categories: { orderBy: { sortOrder: 'asc' } } } });
    if (!branch) return response.status(404).json({ error: { message: 'Restaurant was not found.' } });
    const items = await prisma.menuItem.findMany({ where: { branchId, available: true, deletedAt: null }, include: { category: true }, orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }] });
    response.json({ branch: { id: branch.id, name: branch.name, address: branch.address, deliveryOriginLat: branch.deliveryOriginLat, deliveryOriginLon: branch.deliveryOriginLon, phone: branch.phone, restaurant: { name: branch.restaurant.name }, taxRate: branch.taxRate }, categories: branch.categories.map(category => category.name), items });
  } catch (error) { next(error); }
});

const publicOrderAttempts = new Map<string, { count: number; resetAt: number }>();
const publicAuthAttempts = new Map<string, { count: number; resetAt: number }>();
function customerAuthRateLimited(ip: string) {
  const attempt = publicAuthAttempts.get(ip);
  if (attempt && attempt.resetAt > Date.now() && attempt.count >= 12) return true;
  const current = attempt && attempt.resetAt > Date.now() ? attempt : { count: 0, resetAt: Date.now() + 15 * 60_000 };
  publicAuthAttempts.set(ip, { count: current.count + 1, resetAt: current.resetAt });
  return false;
}
app.post('/api/customer/register', requireSameOrigin, async (request, response, next) => {
  if (customerAuthRateLimited(request.ip ?? 'unknown')) return response.status(429).json({ error: { message: 'Too many attempts. Please wait a little and try again.' } });
  const parsed = z.object({ branchId: z.string().min(1), name: z.string().trim().min(2).max(120), email: z.string().trim().email().max(254), password: z.string().min(10).max(256), phone: z.string().trim().min(7).max(40), address: z.string().trim().min(8).max(500), landmark: z.string().trim().min(2).max(150) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { message: 'Enter your name, a valid email, password (10+ characters), mobile and full delivery address.' } });
  try {
    const input = parsed.data, email = input.email.toLowerCase();
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId }, select: { id: true } });
    if (!branch) return response.status(404).json({ error: { message: 'Restaurant was not found.' } });
    const token = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now() + customerSessionLifetimeMs);
    const account = await prisma.$transaction(async tx => {
      if (await tx.customerPortalAccount.findUnique({ where: { email } })) throw new Error('CUSTOMER_EMAIL_EXISTS');
      let customer = await tx.customer.findFirst({ where: { branchId: input.branchId, phone: input.phone } });
      if (!customer) customer = await tx.customer.create({ data: { branchId: input.branchId, name: input.name, phone: input.phone } });
      const created = await tx.customerPortalAccount.create({ data: { customerId: customer.id, email, passwordHash: await hash(input.password, 12) }, include: { customer: true } });
      await tx.customer.update({ where: { id: customer.id }, data: { name: input.name, phone: input.phone, notes: `Landmark: ${input.landmark}` } });
      await tx.customerPortalSession.create({ data: { accountId: created.id, tokenHash: tokenDigest(token), expiresAt } });
      return created;
    });
    response.setHeader('Set-Cookie', customerSessionCookie(token));
    response.status(201).json({ customer: { id: account.customerId, name: input.name, email, phone: input.phone } });
  } catch (error) {
    if (error instanceof Error && error.message === 'CUSTOMER_EMAIL_EXISTS') return response.status(409).json({ error: { message: 'An account with this email already exists. Sign in instead.' } });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ error: { message: 'An account with these details already exists. Sign in or check your phone number.' } });
    next(error);
  }
});
app.post('/api/customer/login', requireSameOrigin, async (request, response, next) => {
  if (customerAuthRateLimited(request.ip ?? 'unknown')) return response.status(429).json({ error: { message: 'Too many attempts. Please wait a little and try again.' } });
  const parsed = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { message: 'Enter a valid email and password.' } });
  try {
    const account = await prisma.customerPortalAccount.findUnique({ where: { email: parsed.data.email.toLowerCase() }, include: { customer: true } });
    if (!account || !account.active || !(await compare(parsed.data.password, account.passwordHash))) return response.status(401).json({ error: { message: 'Email or password is incorrect.' } });
    const token = randomBytes(32).toString('base64url');
    await prisma.customerPortalSession.create({ data: { accountId: account.id, tokenHash: tokenDigest(token), expiresAt: new Date(Date.now() + customerSessionLifetimeMs) } });
    response.setHeader('Set-Cookie', customerSessionCookie(token));
    response.json({ customer: { id: account.customer.id, name: account.customer.name, email: account.email, phone: account.customer.phone } });
  } catch (error) { next(error); }
});
app.get('/api/customer/me', requireCustomerSession, (request, response) => {
  const customer = (request as CustomerAuthRequest).customerAuth!;
  response.json({ customer: { id: customer.customerId, name: customer.name, email: customer.email, phone: customer.phone } });
});
app.get('/api/customer/events', requireCustomerSession, (request, response) => {
  const customerId = (request as CustomerAuthRequest).customerAuth!.customerId;
  response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  response.flushHeaders();
  response.write('retry: 3000\nevent: connected\ndata: {}\n\n');
  const streams = customerEventStreams.get(customerId) ?? new Set<Response>();
  streams.add(response);
  customerEventStreams.set(customerId, streams);
  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 25000);
  request.on('close', () => {
    clearInterval(heartbeat);
    streams.delete(response);
    if (!streams.size) customerEventStreams.delete(customerId);
  });
});
app.get('/api/customer/cart', requireCustomerSession, async (request, response, next) => {
  const auth = (request as CustomerAuthRequest).customerAuth!;
  try {
    const account = await prisma.customerPortalAccount.findUnique({ where: { id: auth.accountId }, select: { cart: true } });
    response.json({ items: Array.isArray(account?.cart) ? account.cart : [] });
  } catch (error) { next(error); }
});
app.put('/api/customer/cart', requireSameOrigin, requireCustomerSession, async (request, response, next) => {
  const auth = (request as CustomerAuthRequest).customerAuth!;
  const parsed = z.object({ items: z.array(z.object({ menuItemId: z.string().min(1), quantity: z.number().int().min(1).max(20) })).max(30) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { message: 'Cart can contain up to 30 dishes, with up to 20 of each.' } });
  try {
    const unique = new Map(parsed.data.items.map(item => [item.menuItemId, item]));
    const items = [...unique.values()];
    const account = await prisma.customerPortalAccount.findUnique({ where: { id: auth.accountId }, select: { customer: { select: { branchId: true } } } });
    if (!account) return response.status(401).json({ error: { message: 'Sign in again to save your cart.' } });
    const available = await prisma.menuItem.findMany({ where: { branchId: account.customer.branchId, id: { in: items.map(item => item.menuItemId) }, available: true, deletedAt: null }, select: { id: true } });
    if (available.length !== items.length) return response.status(400).json({ error: { message: 'A dish in your cart is no longer available. Refresh the menu.' } });
    await prisma.customerPortalAccount.update({ where: { id: auth.accountId }, data: { cart: items } });
    response.json({ items });
  } catch (error) { next(error); }
});
app.post('/api/customer/logout', requireSameOrigin, async (request, response, next) => {
  const token = cookieValue(request, 'customer_session');
  try {
    if (token) await prisma.customerPortalSession.updateMany({ where: { tokenHash: tokenDigest(token), revokedAt: null }, data: { revokedAt: new Date() } });
    response.setHeader('Set-Cookie', customerSessionCookie('', 0));
    response.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/customer/orders', requireCustomerSession, async (request, response, next) => {
  const auth = (request as CustomerAuthRequest).customerAuth!;
  const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
  try {
    const records = await prisma.order.findMany({ where: { customerId: auth.customerId, branchId, type: OrderType.DELIVERY }, select: { number: true, createdAt: true, status: true, total: true, deliveryFee: true, deliveryDistanceKm: true, deliveryAddress: true, deliveryAssignment: { select: { status: true, updatedAt: true, staff: { select: { name: true, phone: true } }, history: { select: { status: true, note: true, createdAt: true }, orderBy: { createdAt: 'asc' } } } }, items: { select: { itemName: true, quantity: true, lineTotal: true } } }, orderBy: { createdAt: 'desc' }, take: 30 });
    const orders = records.map(order => ({ ...order, deliveryAssignment: order.deliveryAssignment ? { ...order.deliveryAssignment, staff: ['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(order.deliveryAssignment.status) ? order.deliveryAssignment.staff : null } : null }));
    response.json({ orders });
  } catch (error) { next(error); }
});
app.post('/api/customer/orders', requireSameOrigin, requireCustomerSession, async (request, response, next) => {
  const customerAuth = (request as CustomerAuthRequest).customerAuth!;
  const ip = request.ip ?? 'unknown';
  const attempt = publicOrderAttempts.get(ip);
  if (attempt && attempt.resetAt > Date.now() && attempt.count >= 12) return response.status(429).json({ error: { message: 'Too many order attempts. Please try again shortly.' } });
  const parsed = z.object({ branchId: z.string().min(1), phone: z.string().trim().min(7).max(40), address: z.string().trim().min(8).max(500), landmark: z.string().trim().min(2).max(150), instructions: z.string().trim().max(500).optional(), deliveryFee: moneyText.refine(value => Number(value) <= 10000), items: z.array(z.object({ menuItemId: z.string().min(1), quantity: z.number().int().min(1).max(20) })).min(1).max(30) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { message: 'Enter a valid phone number and full delivery address, then add menu items.' } });
  const input = parsed.data;
  try {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId }, select: { id: true, taxRate: true, address: true, deliveryOriginLat: true, deliveryOriginLon: true } });
    if (!branch) return response.status(404).json({ error: { message: 'Restaurant was not found.' } });
    if (!branch.address?.trim() && (branch.deliveryOriginLat == null || branch.deliveryOriginLon == null)) return response.status(400).json({ error: { message: 'Restaurant delivery origin is not configured yet. Please call the restaurant to order.' } });
    const accountCustomer = await prisma.customer.findUnique({ where: { id: customerAuth.customerId }, select: { id: true, branchId: true } });
    if (!accountCustomer || accountCustomer.branchId !== input.branchId) return response.status(403).json({ error: { message: 'Your customer account is not connected to this restaurant.' } });
    const products = await prisma.menuItem.findMany({ where: { branchId: input.branchId, id: { in: input.items.map(item => item.menuItemId) }, available: true, deletedAt: null } });
    if (products.length !== new Set(input.items.map(item => item.menuItemId)).size) return response.status(400).json({ error: { message: 'A selected dish is no longer available. Refresh the menu and try again.' } });
    const byId = new Map(products.map(product => [product.id, product]));
    const lines = input.items.map(item => { const product = byId.get(item.menuItemId)!; return { menuItemId: product.id, itemName: product.name, quantity: item.quantity, unitPrice: product.price, lineTotal: product.price.mul(item.quantity), taxRate: new Prisma.Decimal(branch.taxRate), notes: '' }; });
    const subtotal = lines.reduce((sum, line) => sum.add(line.lineTotal), new Prisma.Decimal(0));
    const deliveryFee = new Prisma.Decimal(input.deliveryFee);
    const taxAmount = orderTax(lines, new Prisma.Decimal(0), deliveryFee, new Prisma.Decimal(branch.taxRate));
    const customer = await prisma.customer.update({ where: { id: customerAuth.customerId }, data: { phone: input.phone } });
    const key = `web-${randomBytes(18).toString('hex')}`;
    const order = await prisma.order.create({ data: { branchId: input.branchId, type: OrderType.DELIVERY, customerId: customer.id, customerName: customerAuth.name, deliveryPhone: input.phone, deliveryAddress: `${input.address} · Landmark: ${input.landmark}`, deliveryInstructions: input.instructions ?? '', deliveryDistanceKm: null, deliveryFee, status: OrderStatus.PLACED, subtotal, taxAmount, discount: new Prisma.Decimal(0), total: subtotal.add(deliveryFee).add(taxAmount), idempotencyKey: key, items: { create: lines }, deliveryAssignment: { create: { status: 'UNASSIGNED' } } }, select: { number: true, total: true, createdAt: true } });
    const current = attempt && attempt.resetAt > Date.now() ? attempt : { count: 0, resetAt: Date.now() + 15 * 60_000 };
    publicOrderAttempts.set(ip, { count: current.count + 1, resetAt: current.resetAt });
    publishBranchEvent(input.branchId, 'orders.changed', { orderNumber: order.number });
    response.status(201).json({ order: { number: order.number, total: order.total, createdAt: order.createdAt } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ error: { message: 'This phone number could not be saved. Please check it and retry.' } });
    next(error);
  }
});

app.get('/api/auth/setup-status', async (_request, response, next) => {
  try { response.json({ setupRequired: (await prisma.user.count()) === 0 }); }
  catch (error) { next(error); }
});

const bootstrapInput = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email().max(254), password: z.string().min(12).max(256) });
app.post('/api/auth/bootstrap', async (request, response, next) => {
  if (!sameOrigin(request)) return response.status(403).json({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Request origin was not accepted.' } });
  const parsed = bootstrapInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Use a name, valid email, and password with at least 12 characters.' } });
  try {
    const passwordHash = await hash(parsed.data.password, 12);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionLifetimeMs);
    const created = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('restaurant-management-owner-bootstrap'))`;
      if (await tx.user.count()) return null;
      const branchId = process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar';
      const branch = await tx.branch.findUnique({ where: { id: branchId } });
      if (!branch) throw new Error('Seed the development restaurant and branch before owner setup.');
      const user = await tx.user.create({ data: { name: parsed.data.name, email: parsed.data.email.trim().toLowerCase(), passwordHash } });
      await tx.branchMembership.create({ data: { userId: user.id, branchId, role: StaffRole.OWNER } });
      const session = await tx.session.create({ data: { userId: user.id, tokenHash: tokenDigest(token), expiresAt } });
      return { user: { id: user.id, name: user.name, email: user.email }, sessionId: session.id, memberships: [{ branchId, branchName: branch.name, role: StaffRole.OWNER }] };
    });
    if (!created) return response.status(409).json({ error: { code: 'SETUP_COMPLETE', message: 'An owner account already exists.' } });
    response.setHeader('Set-Cookie', sessionCookie(token));
    response.status(201).json(created);
  } catch (error) { next(error); }
});

const loginInput = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) });
app.post('/api/auth/login', async (request, response, next) => {
  if (!sameOrigin(request)) return response.status(403).json({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Request origin was not accepted.' } });
  const parsed = loginInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email and password.' } });
  const ip = request.ip ?? 'unknown';
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.resetAt > Date.now() && attempt.count >= 8) return response.status(429).json({ error: { code: 'LOGIN_RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.' } });
  try {
    const email = parsed.data.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email }, include: { memberships: { where: { active: true }, include: { branch: true } } } });
    if (!user || !user.active || !(await compare(parsed.data.password, user.passwordHash))) {
      const current = attempt && attempt.resetAt > Date.now() ? attempt : { count: 0, resetAt: Date.now() + 15 * 60_000 };
      loginAttempts.set(ip, { count: current.count + 1, resetAt: current.resetAt });
      return response.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' } });
    }
    loginAttempts.delete(ip);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionLifetimeMs);
    const session = await prisma.session.create({ data: { userId: user.id, tokenHash: tokenDigest(token), expiresAt } });
    response.setHeader('Set-Cookie', sessionCookie(token));
    response.json({ user: { id: user.id, name: user.name, email: user.email }, sessionId: session.id, memberships: user.memberships.map(m => ({ branchId: m.branchId, branchName: m.branch.name, role: m.role })) });
  } catch (error) { next(error); }
});

app.get('/api/auth/me', requireSession, (request, response) => {
  const auth = (request as AuthRequest).auth!;
  response.json({ user: auth.user, memberships: auth.memberships });
});

app.get('/api/staff',requireSession,async(request,response,next)=>{const branchId=String(request.query.branchId??'');const membership=branchMembership(request,branchId);if(!membership||!rolePermissions[membership.role].includes('staff.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot manage staff at this branch.'}});try{const memberships=await prisma.branchMembership.findMany({where:{branchId},include:{user:{select:{id:true,name:true,email:true,phone:true,active:true}}},orderBy:{user:{name:'asc'}}});response.json({staff:memberships.map(item=>({membershipId:item.id,role:item.role,...item.user,active:item.active&&item.user.active}))})}catch(error){next(error)}});
app.post('/api/staff',requireSameOrigin,requireSession,async(request,response,next)=>{const parsed=z.object({branchId:z.string().min(1),name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(254),phone:z.string().trim().min(7).max(40),password:z.string().min(12).max(256),role:z.nativeEnum(StaffRole).refine(role=>role!==StaffRole.OWNER)}).safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Enter a valid mobile number and provide name, email, password, and staff role.'}});try{const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('staff.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot add staff at this branch.'}});const user=await prisma.user.create({data:{name:parsed.data.name,email:parsed.data.email.toLowerCase(),phone:parsed.data.phone,passwordHash:await hash(parsed.data.password,12)}});const staffMembership=await prisma.branchMembership.create({data:{userId:user.id,branchId:parsed.data.branchId,role:parsed.data.role}});await prisma.auditLog.create({data:{branchId:parsed.data.branchId,userId:auth.user.id,action:'STAFF_CREATED',details:{staffUserId:user.id,role:parsed.data.role}}});response.status(201).json({staff:{membershipId:staffMembership.id,id:user.id,name:user.name,email:user.email,phone:user.phone,role:staffMembership.role,active:true}})}catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')return response.status(409).json({error:{code:'EMAIL_EXISTS',message:'An account with that email already exists.'}});next(error)}});
app.patch('/api/staff/:membershipId',requireSameOrigin,requireSession,async(request,response,next)=>{const parsed=z.object({branchId:z.string().min(1),active:z.boolean(),role:z.nativeEnum(StaffRole).refine(role=>role!==StaffRole.OWNER)}).safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Choose an allowed staff role and active status.'}});try{const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('staff.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot update staff at this branch.'}});const result=await prisma.branchMembership.updateMany({where:{id:String(request.params.membershipId),branchId:parsed.data.branchId},data:{active:parsed.data.active,role:parsed.data.role}});if(!result.count)return response.status(404).json({error:{code:'STAFF_NOT_FOUND',message:'Staff membership was not found.'}});await prisma.auditLog.create({data:{branchId:parsed.data.branchId,userId:auth.user.id,action:'STAFF_UPDATED',details:{membershipId:String(request.params.membershipId),active:parsed.data.active,role:parsed.data.role}}});response.json({ok:true})}catch(error){next(error)}});

app.post('/api/auth/logout', requireSession, async (request, response, next) => {
  if (!sameOrigin(request)) return response.status(403).json({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Request origin was not accepted.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    await prisma.session.update({ where: { id: auth.sessionId }, data: { revokedAt: new Date() } });
    response.setHeader('Set-Cookie', `restaurant_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    response.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/customers', requireSession, requireBranchPermission('customers.read'), async (request, response, next) => {
  try {
    const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
    const query = String(request.query.search ?? '').trim();
    const customers = await prisma.customer.findMany({
      where: { branchId, ...(query ? { OR: [{ name: { contains: query, mode: 'insensitive' as const } }, { phone: { contains: query } }, { email: { contains: query, mode: 'insensitive' as const } }] } : {}) },
      include: { _count: { select: { orders: true } }, orders: { select: { total: true }, where: { status: { not: OrderStatus.CANCELLED } } } },
      orderBy: { name: 'asc' }, take: 250,
    });
    response.json({ customers: customers.map(({ orders, ...customer }) => ({ ...customer, lifetimeValue: orders.reduce((sum, order) => sum.add(order.total), new Prisma.Decimal(0)) })) });
  } catch (error) { next(error); }
});

const customerInput = z.object({ branchId: z.string().min(1), name: z.string().trim().min(2).max(120), phone: z.string().trim().max(40).optional().transform(value => value || null), email: z.string().trim().email().max(254).optional().or(z.literal('')).transform(value => value || null), notes: z.string().trim().max(1000).default('') });
app.post('/api/customers', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = customerInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a customer name and valid contact details.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    const membership = branchMembership(request, parsed.data.branchId);
    if (!membership || !rolePermissions[membership.role].includes('customers.manage')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to add customers.' } });
    const customer = await prisma.customer.create({ data: parsed.data });
    await prisma.auditLog.create({ data: { branchId: customer.branchId, userId: auth.user.id, action: 'CUSTOMER_CREATED', details: { customerId: customer.id } } });
    response.status(201).json({ customer });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ error: { code: 'CUSTOMER_PHONE_EXISTS', message: 'A customer with that phone number already exists at this branch.' } });
    next(error);
  }
});

app.patch('/api/customers/:id', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = customerInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a customer name and valid contact details.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    const membership = branchMembership(request, parsed.data.branchId);
    if (!membership || !rolePermissions[membership.role].includes('customers.manage')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to update customers.' } });
    const updated = await prisma.customer.updateMany({ where: { id: String(request.params.id), branchId: parsed.data.branchId }, data: { name: parsed.data.name, phone: parsed.data.phone, email: parsed.data.email, notes: parsed.data.notes } });
    if (!updated.count) return response.status(404).json({ error: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer was not found.' } });
    const customer = await prisma.customer.findFirstOrThrow({ where: { id: String(request.params.id), branchId: parsed.data.branchId } });
    await prisma.auditLog.create({ data: { branchId: customer.branchId, userId: auth.user.id, action: 'CUSTOMER_UPDATED', details: { customerId: customer.id } } });
    response.json({ customer });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ error: { code: 'CUSTOMER_PHONE_EXISTS', message: 'A customer with that phone number already exists at this branch.' } });
    next(error);
  }
});

app.get('/api/menu', requireSession, requireBranchPermission('menu.read'), async (request, response, next) => {
  try {
    const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
    const includeUnavailable = request.query.includeUnavailable === 'true' || canManageMenu(request, branchId);
    if (includeUnavailable && !canManageMenu(request, branchId)) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'Only a manager or owner can view unavailable menu items.' } });
    const items = await prisma.menuItem.findMany({
      where: { branchId, ...(includeUnavailable ? {} : { available: true }), deletedAt: null },
      include: { category: true, recipeLines: { include: { inventoryItem: { select: { unitCost: true } } } } }, orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
    });
    response.json({ items: items.map(item => {
      const rawMaterialCost = item.recipeLines.reduce((sum, line) => sum + line.quantity.mul(line.inventoryItem.unitCost).toNumber(), 0);
      const charges = Array.isArray(item.charges) ? item.charges as Array<{ amount?: string | number }> : [];
      const additionalCost = charges.reduce((sum, charge) => sum + Number(charge.amount || 0), 0);
      return { ...item, estimatedCost: item.recipeLines.length ? Number((rawMaterialCost + additionalCost).toFixed(2)) : null };
    }) });
  } catch (error) { next(error); }
});

const menuItemInput = z.object({
  branchId: z.string().min(1), categoryId: z.string().min(1), name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000).default(''), price: moneyText, emoji: z.string().max(16).default('🍽️'),
  imageData: z.string().max(1_500_000).nullable().optional().refine(value => value == null || /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value), 'Choose a valid PNG, JPG, or WebP image.'),
  sku: z.string().trim().max(64).optional(),
});
const canManageMenu = (request: Request, branchId: string) => {
  const membership = branchMembership(request, branchId);
  return Boolean(membership && rolePermissions[membership.role].includes('settings.manage'));
};
app.get('/api/menu/manage', requireSession, async (request, response, next) => {
  try {
    const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
    if (!canManageMenu(request, branchId)) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'Only a manager or owner can manage the menu.' } });
    const [categories, items] = await Promise.all([
      prisma.menuCategory.findMany({ where: { branchId }, orderBy: { sortOrder: 'asc' } }),
      prisma.menuItem.findMany({ where: { branchId, deletedAt: null }, include: { category: true }, orderBy: { name: 'asc' } }),
    ]);
    response.json({ categories, items });
  } catch (error) { next(error); }
});
app.post('/api/menu/items', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = menuItemInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Check the menu item name, category and price.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    const input = parsed.data;
    if (!canManageMenu(request, input.branchId)) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'Only a manager or owner can change the menu.' } });
    const category = await prisma.menuCategory.findFirst({ where: { id: input.categoryId, branchId: input.branchId } });
    if (!category) return response.status(400).json({ error: { code: 'INVALID_CATEGORY', message: 'Choose a category from this branch.' } });
    const item = await prisma.menuItem.create({ data: { branchId: input.branchId, categoryId: category.id, name: input.name, description: input.description, price: new Prisma.Decimal(input.price), emoji: input.emoji, imageData: input.imageData || null, sku: input.sku || null }, include: { category: true } });
    await prisma.auditLog.create({ data: { branchId: input.branchId, userId: auth.user.id, action: 'MENU_ITEM_CREATED', details: { itemId: item.id, name: item.name } } });
    response.status(201).json({ item });
  } catch (error) { next(error); }
});
app.patch('/api/menu/items/:id', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = z.object({ branchId: z.string().min(1), name: z.string().trim().min(2).max(160).optional(), description: z.string().trim().max(1000).optional(), price: moneyText.optional(), emoji: z.string().max(16).optional(), imageData: z.string().max(1_500_000).nullable().optional().refine(value => value == null || /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value), 'Choose a valid PNG, JPG, or WebP image.'), categoryId: z.string().min(1).optional(), available: z.boolean().optional() }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Check the menu item changes.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    const { branchId, ...changes } = parsed.data;
    if (!canManageMenu(request, branchId)) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'Only a manager or owner can change the menu.' } });
    if (changes.categoryId && !await prisma.menuCategory.findFirst({ where: { id: changes.categoryId, branchId } })) return response.status(400).json({ error: { code: 'INVALID_CATEGORY', message: 'Choose a category from this branch.' } });
    const result = await prisma.menuItem.updateMany({ where: { id: String(request.params.id), branchId, deletedAt: null }, data: { ...changes, ...(changes.price ? { price: new Prisma.Decimal(changes.price) } : {}) } });
    if (!result.count) return response.status(404).json({ error: { code: 'MENU_ITEM_NOT_FOUND', message: 'Menu item was not found.' } });
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: String(request.params.id) }, include: { category: true } });
    await prisma.auditLog.create({ data: { branchId, userId: auth.user.id, action: 'MENU_ITEM_UPDATED', details: { itemId: item.id, changes: { ...changes, price: changes.price } } } });
    response.json({ item });
  } catch (error) { next(error); }
});
app.delete('/api/menu/items/:id', requireSameOrigin, requireSession, async (request, response, next) => {
  try {
    const auth = (request as AuthRequest).auth!;
    const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
    if (!canManageMenu(request, branchId)) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'Only a manager or owner can change the menu.' } });
    const result = await prisma.menuItem.updateMany({ where: { id: String(request.params.id), branchId, deletedAt: null }, data: { deletedAt: new Date(), available: false } });
    if (!result.count) return response.status(404).json({ error: { code: 'MENU_ITEM_NOT_FOUND', message: 'Menu item was not found.' } });
    await prisma.auditLog.create({ data: { branchId, userId: auth.user.id, action: 'MENU_ITEM_ARCHIVED', details: { itemId: String(request.params.id) } } });
    response.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/tables', requireSession, async (request, response, next) => {
  try {
    const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
    const membership = branchMembership(request, branchId);
    if (!membership || !rolePermissions[membership.role].includes('tables.read')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have access to tables at this branch.' } });
    const tables = await prisma.diningTable.findMany({ where: { branchId }, include: { orders: { where: { status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } }, orderBy: { createdAt: 'desc' }, take: 1, select: { number: true, customerName: true, createdAt: true, total: true } }, serviceSessions:{where:{status:{in:['OPEN','CLOSED']}},orderBy:{startedAt:'desc'},take:1,include:{bill:true,orders:{where:{status:{not:OrderStatus.CANCELLED}},include:{items:true,payments:true},orderBy:{createdAt:'asc'}}}} }, orderBy: { number: 'asc' } });
    response.json({ tables });
  } catch (error) { next(error); }
});
app.post('/api/tables', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = z.object({ branchId: z.string().min(1), number: z.string().trim().min(1).max(30), seats: z.number().int().min(1).max(40) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a table number and seating capacity.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    const membership = branchMembership(request, parsed.data.branchId);
    if (!membership || !rolePermissions[membership.role].includes('settings.manage')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'Only a manager or owner can add tables.' } });
    const table = await prisma.diningTable.create({ data: { ...parsed.data, status: 'AVAILABLE' } });
    await prisma.auditLog.create({ data: { branchId: table.branchId, userId: auth.user.id, action: 'TABLE_CREATED', details: { tableId: table.id, number: table.number, seats: table.seats } } });
    publishBranchEvent(table.branchId, 'tables.changed', { tableId: table.id });
    response.status(201).json({ table });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ error: { code: 'TABLE_NUMBER_EXISTS', message: 'That table number already exists in this branch.' } });
    next(error);
  }
});
app.patch('/api/tables/:id/status', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = z.object({ branchId: z.string().min(1), status: z.enum(['AVAILABLE','OCCUPIED','RESERVED','CLEANING']) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Choose a valid table status.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    const membership = branchMembership(request, parsed.data.branchId);
    if (!membership || !rolePermissions[membership.role].includes('tables.update')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to update tables.' } });
    const id = String(request.params.id);
    const table = await prisma.diningTable.findFirst({ where: { id, branchId: parsed.data.branchId } });
    if (!table) return response.status(404).json({ error: { code: 'TABLE_NOT_FOUND', message: 'Table was not found.' } });
      if (parsed.data.status === 'AVAILABLE') {
      const openSession=await prisma.tableSession.findFirst({where:{tableId:table.id,status:'OPEN'},select:{id:true}});
      if(openSession)return response.status(409).json({error:{code:'TABLE_SESSION_OPEN',message:'Settle or close the table session before marking this table available.'}});
      const activeOrder = await prisma.order.findFirst({ where: { tableId: table.id, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } }, select: { id: true } });
      if (activeOrder) return response.status(409).json({ error: { code: 'TABLE_HAS_ACTIVE_ORDER', message: 'Complete or transfer the active order before releasing this table.' } });
    }
    const updated = await prisma.diningTable.updateMany({ where: { id, branchId: table.branchId, status: table.status }, data: { status: parsed.data.status } });
    if (!updated.count) return response.status(409).json({ error: { code: 'TABLE_STATUS_CONFLICT', message: 'Another staff member changed this table. Refresh and retry.' } });
    const fresh = await prisma.diningTable.findUniqueOrThrow({ where: { id } });
    await prisma.auditLog.create({ data: { branchId: fresh.branchId, userId: auth.user.id, action: 'TABLE_STATUS_CHANGED', details: { tableId: fresh.id, from: table.status, to: fresh.status } } });
    publishBranchEvent(fresh.branchId, 'tables.changed', { tableId: fresh.id });
    response.json({ table: fresh });
  } catch (error) { next(error); }
});

app.get('/api/orders', requireSession, requireBranchPermission('orders.read'), async (request, response, next) => {
  try {
    const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
    const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,branchId)!;
    const take = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 100);
    const orders = await prisma.order.findMany({ where: { branchId, ...(membership.role===StaffRole.DELIVERY?{deliveryAssignment:{is:{staffId:auth.user.id}}}:{}) }, include: { items: true, payments: true, table: { select: { number: true } } }, orderBy: { createdAt: 'desc' }, take });
    response.json({ orders });
  } catch (error) { next(error); }
});

app.get('/api/inventory', requireSession, requireBranchPermission('inventory.read'), async (request, response, next) => {
  try {
    const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
    const items = await prisma.inventoryItem.findMany({ where: { branchId, active: true }, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
    response.json({ items });
  } catch (error) { next(error); }
});
app.get('/api/inventory/:id/movements',requireSession,async(request,response,next)=>{try{const branchId=String(request.query.branchId??'');const membership=branchMembership(request,branchId);if(!membership||!rolePermissions[membership.role].includes('inventory.read'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot view stock movement history at this branch.'}});const item=await prisma.inventoryItem.findFirst({where:{id:String(request.params.id),branchId}});if(!item)return response.status(404).json({error:{code:'INVENTORY_ITEM_NOT_FOUND',message:'Ingredient was not found.'}});const movements=await prisma.stockMovement.findMany({where:{inventoryItemId:item.id},orderBy:{createdAt:'desc'},take:250});response.json({movements})}catch(error){next(error)}});
app.get('/api/inventory/units',requireSession,async(request,response,next)=>{try{const branchId=String(request.query.branchId??'');const membership=branchMembership(request,branchId);if(!membership||!rolePermissions[membership.role].includes('inventory.read'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot view stock units at this branch.'}});const [units,items]=await Promise.all([prisma.inventoryUnit.findMany({where:{branchId},orderBy:{name:'asc'}}),prisma.inventoryItem.findMany({where:{branchId},select:{unit:true},distinct:['unit']})]);response.json({units:Array.from(new Set([...units.map(unit=>unit.name),...items.map(item=>item.unit)] )).sort((a,b)=>a.localeCompare(b))})}catch(error){next(error)}});
app.post('/api/inventory/units',requireSameOrigin,requireSession,async(request,response,next)=>{const parsed=z.object({branchId:z.string().min(1),name:z.string().trim().min(1).max(20)}).safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Enter a unit name up to 20 characters.'}});try{const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('inventory.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot add stock units at this branch.'}});const unit=await prisma.inventoryUnit.upsert({where:{branchId_name:{branchId:parsed.data.branchId,name:parsed.data.name}},create:parsed.data,update:{}});response.status(201).json({unit})}catch(error){next(error)}});
const inventoryInput = z.object({ branchId: z.string().min(1), name: z.string().trim().min(2).max(120), category: z.string().trim().min(1).max(80).default('General'), unit: z.string().trim().min(1).max(20).default('pcs'), quantity: z.string().regex(/^\d+(?:\.\d{1,3})?$/).default('0'), reorderLevel: z.string().regex(/^\d+(?:\.\d{1,3})?$/).default('0'), unitCost: moneyText.default('0') });
app.post('/api/inventory', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = inventoryInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Check the ingredient name, unit, quantity and cost.' } });
  try {
    const auth = (request as AuthRequest).auth!; const membership = branchMembership(request, parsed.data.branchId);
    if (!membership || !rolePermissions[membership.role].includes('inventory.manage')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You cannot manage inventory at this branch.' } });
    const item = await prisma.inventoryItem.create({ data: { ...parsed.data, quantity: new Prisma.Decimal(parsed.data.quantity), reorderLevel: new Prisma.Decimal(parsed.data.reorderLevel), unitCost: new Prisma.Decimal(parsed.data.unitCost) } });
    if (Number(parsed.data.quantity) > 0) await prisma.stockMovement.create({ data: { inventoryItemId: item.id, type: 'OPENING', quantity: item.quantity, reason: 'Opening stock' } });
    await prisma.auditLog.create({ data: { branchId: item.branchId, userId: auth.user.id, action: 'INVENTORY_ITEM_CREATED', details: { itemId: item.id } } });
    response.status(201).json({ item });
  } catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ error: { code: 'INVENTORY_ITEM_EXISTS', message: 'That ingredient already exists at this branch.' } }); next(error); }
});
app.post('/api/inventory/:id/adjust', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = z.object({ branchId: z.string().min(1), delta: z.string().regex(/^-?\d+(?:\.\d{1,3})?$/).refine(value => Number(value) !== 0), reason: z.string().trim().min(3).max(300) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a non-zero stock change and reason.' } });
  try {
    const auth = (request as AuthRequest).auth!; const membership = branchMembership(request, parsed.data.branchId);
    if (!membership || !rolePermissions[membership.role].includes('inventory.manage')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You cannot adjust inventory at this branch.' } });
    const item = await prisma.inventoryItem.findFirst({ where: { id: String(request.params.id), branchId: parsed.data.branchId, active: true } });
    if (!item) return response.status(404).json({ error: { code: 'INVENTORY_ITEM_NOT_FOUND', message: 'Ingredient was not found.' } });
    const delta = new Prisma.Decimal(parsed.data.delta), nextQuantity = item.quantity.add(delta);
    if (nextQuantity.lt(0)) return response.status(409).json({ error: { code: 'INSUFFICIENT_STOCK', message: 'Stock cannot be adjusted below zero.' } });
    const result = await prisma.$transaction(async tx => {
      const updated = await tx.inventoryItem.updateMany({ where: { id: item.id, quantity: item.quantity }, data: { quantity: nextQuantity } });
      if (!updated.count) throw new Error('STOCK_CONFLICT');
      await tx.stockMovement.create({ data: { inventoryItemId: item.id, type: delta.gt(0) ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT', quantity: delta, reason: parsed.data.reason } });
      await tx.auditLog.create({ data: { branchId: item.branchId, userId: auth.user.id, action: 'STOCK_ADJUSTED', details: { itemId: item.id, delta: delta.toString(), reason: parsed.data.reason } } });
      return tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    });
    response.json({ item: result });
  } catch (error) { if (error instanceof Error && error.message === 'STOCK_CONFLICT') return response.status(409).json({ error: { code: 'STOCK_CONFLICT', message: 'Another staff member changed this stock. Refresh and retry.' } }); next(error); }
});

app.get('/api/inventory/recipes', requireSession, async (request, response, next) => {
  const branchId = String(request.query.branchId ?? '');
  const membership = branchMembership(request, branchId);
  if (!membership || !rolePermissions[membership.role].includes('inventory.read')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You cannot view recipes at this branch.' } });
  try {
    const [menuItems, inventoryItems] = await Promise.all([
      prisma.menuItem.findMany({ where: { branchId, deletedAt: null }, include: { category: { select: { name: true } }, recipeLines: { include: { inventoryItem: { select: { id: true, name: true, unit: true, unitCost: true } } }, orderBy: { inventoryItem: { name: 'asc' } } } }, orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }] }),
      prisma.inventoryItem.findMany({ where: { branchId, active: true }, select: { id: true, name: true, unit: true, quantity: true, unitCost: true }, orderBy: { name: 'asc' } }),
    ]);
    response.json({ menuItems, inventoryItems });
  } catch (error) { next(error); }
});

const menuRecipeInput = z.object({ branchId: z.string().min(1), lines: z.array(z.object({ inventoryItemId: z.string().min(1), quantity: z.string().regex(/^\d+(?:\.\d{1,3})?$/).refine(value => Number(value) > 0) })).max(100).refine(lines => new Set(lines.map(line => line.inventoryItemId)).size === lines.length), charges: z.array(z.object({ name: z.string().trim().min(1).max(80), amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/), remarks: z.string().trim().max(160).default('') })).max(20).default([]) });
app.put('/api/menu/items/:menuItemId/recipe', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = menuRecipeInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Add valid ingredient quantities without duplicates.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    const membership = branchMembership(request, parsed.data.branchId);
    if (!membership || !rolePermissions[membership.role].includes('inventory.manage')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You cannot manage recipes at this branch.' } });
    const menuItem = await prisma.menuItem.findFirst({ where: { id: String(request.params.menuItemId), branchId: parsed.data.branchId, deletedAt: null }, select: { id: true, name: true } });
    if (!menuItem) return response.status(404).json({ error: { code: 'MENU_ITEM_NOT_FOUND', message: 'Menu item was not found at this branch.' } });
    const ingredients = await prisma.inventoryItem.findMany({ where: { id: { in: parsed.data.lines.map(line => line.inventoryItemId) }, branchId: parsed.data.branchId, active: true }, select: { id: true } });
    if (ingredients.length !== parsed.data.lines.length) return response.status(400).json({ error: { code: 'INVALID_INGREDIENT', message: 'Choose active stock items from this branch.' } });
    const recipe = await prisma.$transaction(async tx => {
      await tx.menuItem.update({ where: { id: menuItem.id }, data: { charges: parsed.data.charges.map(charge => ({ ...charge, amount: new Prisma.Decimal(charge.amount).toFixed(2) })) } });
      await tx.menuRecipeLine.deleteMany({ where: { menuItemId: menuItem.id } });
      const now = new Date();
      if (parsed.data.lines.length) await tx.menuRecipeLine.createMany({ data: parsed.data.lines.map(line => ({ menuItemId: menuItem.id, inventoryItemId: line.inventoryItemId, quantity: new Prisma.Decimal(line.quantity), createdAt: now, updatedAt: now })) });
      await tx.auditLog.create({ data: { branchId: parsed.data.branchId, userId: auth.user.id, action: 'MENU_RECIPE_UPDATED', details: { menuItemId: menuItem.id, ingredientCount: parsed.data.lines.length } } });
      return { lines: await tx.menuRecipeLine.findMany({ where: { menuItemId: menuItem.id }, include: { inventoryItem: { select: { id: true, name: true, unit: true, unitCost: true } } }, orderBy: { inventoryItem: { name: 'asc' } } }), charges: (await tx.menuItem.findUniqueOrThrow({ where: { id: menuItem.id }, select: { charges: true } })).charges };
    });
    response.json({ recipe: recipe.lines, charges: recipe.charges });
  } catch (error) { next(error); }
});

app.get('/api/suppliers', requireSession, requireBranchPermission('suppliers.read'), async (request, response, next) => {
  try { const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar'); const suppliers = await prisma.supplier.findMany({ where: { branchId, active: true }, orderBy: { name: 'asc' } }); response.json({ suppliers }); }
  catch (error) { next(error); }
});
const supplierInput = z.object({ branchId: z.string().min(1), name: z.string().trim().min(2).max(140), contactName: z.string().trim().max(120).default(''), phone: z.string().trim().max(40).default(''), email: z.string().trim().max(254).default(''), address: z.string().trim().max(500).default(''), openingBalance: z.string().regex(/^\d+(?:\.\d{1,2})?$/).default('0') });
app.post('/api/suppliers', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = supplierInput.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a supplier name and valid contact details.' } });
  try { const auth=(request as AuthRequest).auth!; const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('suppliers.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot manage suppliers at this branch.'}});const supplier=await prisma.supplier.create({data:{...parsed.data,openingBalance:new Prisma.Decimal(parsed.data.openingBalance),contactName:parsed.data.contactName||null,phone:parsed.data.phone||null,email:parsed.data.email||null,address:parsed.data.address||null}});await prisma.auditLog.create({data:{branchId:supplier.branchId,userId:auth.user.id,action:'SUPPLIER_CREATED',details:{supplierId:supplier.id}}});response.status(201).json({supplier});}
  catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){const supplier=await prisma.supplier.findFirst({where:{branchId:parsed.data.branchId,name:parsed.data.name,active:true}});return response.status(200).json({supplier,existing:true})}next(error);}
});

app.get('/api/suppliers/:id/ledger', requireSession, async (request, response, next) => {
  try {
    const branchId=String(request.query.branchId??''); const membership=branchMembership(request,branchId);
    if(!membership||!rolePermissions[membership.role].includes('suppliers.read'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot view supplier records at this branch.'}});
    const supplier=await prisma.supplier.findFirst({where:{id:String(request.params.id),branchId}});if(!supplier)return response.status(404).json({error:{code:'SUPPLIER_NOT_FOUND',message:'Supplier was not found.'}});
    const [orders,payments]=await Promise.all([prisma.purchaseOrder.findMany({where:{branchId,supplierId:supplier.id},include:{items:{include:{inventoryItem:{select:{name:true,unit:true}}}}},orderBy:{createdAt:'asc'}}),prisma.supplierPayment.findMany({where:{branchId,supplierId:supplier.id},orderBy:{paidAt:'asc'}})]);
    const entries:any[]=[];if(supplier.openingBalance.gt(0))entries.push({id:`opening-${supplier.id}`,date:supplier.createdAt,type:'OPENING',description:'Opening balance',debit:supplier.openingBalance.toString(),credit:'0'});
    for(const order of orders){const total=order.items.reduce((sum,item)=>{const base=Number(item.unitCost)*Number(item.orderedQuantity);return sum+base+Math.round(base*Number(item.taxRate)/100*100)/100},0);entries.push({id:order.id,date:order.createdAt,type:'PURCHASE',description:`Purchase order #${order.number}${order.reference?` · ${order.reference}`:''}`,debit:total.toFixed(2),credit:'0',order});}
    for(const payment of payments)entries.push({id:payment.id,date:payment.paidAt,type:'PAYMENT',description:`Supplier payment${payment.reference?` · ${payment.reference}`:''}`,debit:'0',credit:payment.amount.toString(),payment});
    entries.sort((a,b)=>new Date(a.date).getTime()-new Date(b.date).getTime());let balance=0;for(const entry of entries){balance+=Number(entry.debit)-Number(entry.credit);entry.balance=balance.toFixed(2)}
    response.json({supplier,entries:entries.reverse(),summary:{purchases:orders.length,paid:payments.reduce((sum,p)=>sum+Number(p.amount),0),balance:balance.toFixed(2)}});
  }catch(error){next(error)}
});
app.post('/api/suppliers/:id/payments',requireSameOrigin,requireSession,async(request,response,next)=>{
  const parsed=z.object({branchId:z.string().min(1),amount:moneyText.refine(value=>Number(value)>0),paymentMethod:z.enum(['CASH','BANK','CHEQUE','UPI']).default('BANK'),reference:z.string().trim().max(100).default(''),notes:z.string().trim().max(500).default(''),paidAt:z.string().datetime().optional()}).safeParse(request.body);
  if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Enter a positive payment amount and valid payment details.'}});
  try{const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('suppliers.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot record supplier payments at this branch.'}});const supplier=await prisma.supplier.findFirst({where:{id:String(request.params.id),branchId:parsed.data.branchId}});if(!supplier)return response.status(404).json({error:{code:'SUPPLIER_NOT_FOUND',message:'Supplier was not found.'}});const payment=await prisma.supplierPayment.create({data:{branchId:parsed.data.branchId,supplierId:supplier.id,amount:new Prisma.Decimal(parsed.data.amount),paymentMethod:parsed.data.paymentMethod,reference:parsed.data.reference||null,notes:parsed.data.notes,paidAt:parsed.data.paidAt?new Date(parsed.data.paidAt):new Date()}});await prisma.auditLog.create({data:{branchId:parsed.data.branchId,userId:auth.user.id,action:'SUPPLIER_PAYMENT_RECORDED',details:{supplierId:supplier.id,paymentId:payment.id,amount:payment.amount.toString()}}});response.status(201).json({payment});}catch(error){next(error)}
});

app.get('/api/purchases', requireSession, requireBranchPermission('purchases.read'), async (request, response, next) => {
  try { const branchId=String(request.query.branchId??process.env.DEMO_BRANCH_ID??'demo-indiranagar');const orders=await prisma.purchaseOrder.findMany({where:{branchId},include:{supplier:{select:{id:true,name:true}},items:{include:{inventoryItem:{select:{name:true,unit:true}}}}},orderBy:{createdAt:'desc'},take:100});response.json({orders}); } catch(error){next(error)}
});
const purchaseInput=z.object({branchId:z.string().min(1),supplierId:z.string().min(1),reference:z.string().trim().max(100).default(''),notes:z.string().trim().max(500).default(''),items:z.array(z.object({inventoryItemId:z.string().min(1),quantity:z.string().regex(/^\d+(?:\.\d{1,3})?$/).refine(value=>Number(value)>0),unitCost:moneyText,taxRate:z.string().regex(/^\d{1,2}(?:\.\d{1,2})?$/).refine(value=>Number(value)<=100).default('0'),unit:z.string().trim().min(1).max(20).default('pcs'),unitFactor:z.string().regex(/^\d+(?:\.\d{1,6})?$/).refine(value=>Number(value)>0).default('1')})).min(1).max(100)}).refine(value=>new Set(value.items.map(item=>item.inventoryItemId)).size===value.items.length);
app.post('/api/purchases',requireSameOrigin,requireSession,async(request,response,next)=>{
 const parsed=purchaseInput.safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Choose a supplier and enter valid order quantities and costs.'}});
 try{const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('purchases.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot create purchase orders at this branch.'}});
 const [supplier,stockItems]=await Promise.all([prisma.supplier.findFirst({where:{id:parsed.data.supplierId,branchId:parsed.data.branchId,active:true}}),prisma.inventoryItem.findMany({where:{id:{in:parsed.data.items.map(item=>item.inventoryItemId)},branchId:parsed.data.branchId,active:true}})]);if(!supplier)return response.status(400).json({error:{code:'INVALID_SUPPLIER',message:'Supplier is not active at this branch.'}});if(stockItems.length!==parsed.data.items.length)return response.status(400).json({error:{code:'INVALID_INVENTORY_ITEM',message:'One or more ingredients are unavailable at this branch.'}});
 const allowedUnits=await prisma.inventoryUnit.findMany({where:{branchId:parsed.data.branchId}});const knownUnits=new Set([...allowedUnits.map(unit=>unit.name),...stockItems.map(item=>item.unit)]);if(parsed.data.items.some(item=>!knownUnits.has(item.unit)))return response.status(400).json({error:{code:'INVALID_UNIT',message:'Choose a unit saved for this branch.'}});
 const order=await prisma.purchaseOrder.create({data:{branchId:parsed.data.branchId,supplierId:supplier.id,status:'ORDERED',reference:parsed.data.reference||null,notes:parsed.data.notes,items:{create:parsed.data.items.map(item=>({inventoryItemId:item.inventoryItemId,orderedQuantity:new Prisma.Decimal(item.quantity),unitCost:new Prisma.Decimal(item.unitCost),taxRate:new Prisma.Decimal(item.taxRate),unit:item.unit,unitFactor:new Prisma.Decimal(item.unitFactor)}))}},include:{supplier:{select:{name:true}},items:{include:{inventoryItem:{select:{name:true,unit:true}}}}}});await prisma.auditLog.create({data:{branchId:order.branchId,userId:auth.user.id,action:'PURCHASE_ORDER_CREATED',details:{purchaseOrderId:order.id,number:order.number}}});response.status(201).json({order});
 }catch(error){next(error)}
});
app.post('/api/purchases/:id/receive',requireSameOrigin,requireSession,async(request,response,next)=>{
 const parsed=z.object({branchId:z.string().min(1),items:z.array(z.object({itemId:z.string().min(1),quantity:z.string().regex(/^\d+(?:\.\d{1,3})?$/).refine(value=>Number(value)>0)})).min(1)}).safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Enter received quantities for at least one order line.'}});
 try{const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('purchases.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot receive purchases at this branch.'}});
 const received=await prisma.$transaction(async tx=>{const order=await tx.purchaseOrder.findFirst({where:{id:String(request.params.id),branchId:parsed.data.branchId},include:{items:true}});if(!order)return null;if(order.status==='RECEIVED')throw new Error('PURCHASE_ALREADY_RECEIVED');for(const row of parsed.data.items){const line=order.items.find(item=>item.id===row.itemId);if(!line)throw new Error('PURCHASE_LINE_NOT_FOUND');const amount=new Prisma.Decimal(row.quantity);const next=line.receivedQuantity.add(amount);if(next.gt(line.orderedQuantity))throw new Error('RECEIPT_EXCEEDS_ORDER');const lineUpdate=await tx.purchaseOrderItem.updateMany({where:{id:line.id,receivedQuantity:line.receivedQuantity},data:{receivedQuantity:next}});if(!lineUpdate.count)throw new Error('RECEIPT_CONFLICT');const stock=await tx.inventoryItem.findUniqueOrThrow({where:{id:line.inventoryItemId}});const converted=amount.mul(line.unitFactor);const stockUpdate=await tx.inventoryItem.updateMany({where:{id:stock.id,quantity:stock.quantity},data:{quantity:stock.quantity.add(converted),unitCost:line.unitCost.div(line.unitFactor)}});if(!stockUpdate.count)throw new Error('STOCK_CONFLICT');await tx.stockMovement.create({data:{inventoryItemId:stock.id,type:'PURCHASE_RECEIPT',quantity:converted,reason:`Purchase order #${order.number} receipt`,reference:order.id}})}const fresh=await tx.purchaseOrder.findUniqueOrThrow({where:{id:order.id},include:{items:true,supplier:{select:{name:true}}}});const complete=fresh.items.every(item=>item.receivedQuantity.gte(item.orderedQuantity));const status=complete?'RECEIVED':'PARTIALLY_RECEIVED';return tx.purchaseOrder.update({where:{id:fresh.id},data:{status,receivedAt:complete?new Date():undefined},include:{items:true,supplier:{select:{name:true}}}})}, {isolationLevel:Prisma.TransactionIsolationLevel.Serializable});if(!received)return response.status(404).json({error:{code:'PURCHASE_NOT_FOUND',message:'Purchase order was not found.'}});await prisma.auditLog.create({data:{branchId:received.branchId,userId:auth.user.id,action:'PURCHASE_RECEIVED',details:{purchaseOrderId:received.id,status:received.status}}});response.json({order:received});
 }catch(error){const messages:Record<string,string>={PURCHASE_ALREADY_RECEIVED:'This purchase order is already fully received.',PURCHASE_LINE_NOT_FOUND:'A receipt line was not part of this purchase order.',RECEIPT_EXCEEDS_ORDER:'Received quantity cannot exceed the outstanding quantity.',RECEIPT_CONFLICT:'Another user updated this purchase order. Refresh and retry.',STOCK_CONFLICT:'Another user changed this stock. Refresh and retry.'};if(error instanceof Error&&messages[error.message])return response.status(409).json({error:{code:error.message,message:messages[error.message]}});next(error)}
});

app.get('/api/expense-categories',requireSession,async(request,response,next)=>{try{const branchId=String(request.query.branchId??'');const membership=branchMembership(request,branchId);if(!membership||!rolePermissions[membership.role].includes('expenses.read'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot view expense categories at this branch.'}});const [saved,used]=await Promise.all([prisma.expenseCategory.findMany({where:{branchId},orderBy:{name:'asc'},select:{name:true}}),prisma.expense.findMany({where:{branchId},distinct:['category'],select:{category:true}})]);response.json({categories:Array.from(new Set([...saved.map(row=>row.name),...used.map(row=>row.category)])).sort((a,b)=>a.localeCompare(b))})}catch(error){next(error)}});
app.post('/api/expense-categories',requireSameOrigin,requireSession,async(request,response,next)=>{const parsed=z.object({branchId:z.string().min(1),name:z.string().trim().min(2).max(80)}).safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Enter an expense category name between 2 and 80 characters.'}});try{const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('expenses.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot manage expense categories at this branch.'}});const category=await prisma.expenseCategory.upsert({where:{branchId_name:{branchId:parsed.data.branchId,name:parsed.data.name}},create:parsed.data,update:{}});response.status(200).json({category})}catch(error){next(error)}});
app.get('/api/expenses',requireSession,requireBranchPermission('expenses.read'),async(request,response,next)=>{
 try{
  const branchId=String(request.query.branchId??process.env.DEMO_BRANCH_ID??'demo-indiranagar');
  const parsed=z.object({from:z.string().datetime().optional(),to:z.string().datetime().optional(),search:z.string().trim().max(120).optional()}).safeParse(request.query);
  if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Choose a valid expense date range.'}});
  const dateRange={...(parsed.data.from?{gte:new Date(parsed.data.from)}:{}),...(parsed.data.to?{lte:new Date(parsed.data.to)}:{})};
  const term=parsed.data.search;
  const expenseWhere:Prisma.ExpenseWhereInput={branchId,expenseDate:dateRange,...(term?{OR:[{description:{contains:term,mode:'insensitive'}},{category:{contains:term,mode:'insensitive'}},{notes:{contains:term,mode:'insensitive'}},{supplier:{name:{contains:term,mode:'insensitive'}}}]}:{})};
  const paymentWhere:Prisma.SupplierPaymentWhereInput={branchId,paidAt:dateRange,...(term?{OR:[{reference:{contains:term,mode:'insensitive'}},{notes:{contains:term,mode:'insensitive'}},{supplier:{name:{contains:term,mode:'insensitive'}}}]}:{})};
  const movementWhere:Prisma.CashMovementWhereInput={type:'OUT',createdAt:dateRange,session:{branchId},...(term?{reason:{contains:term,mode:'insensitive'}}:{})};
  const [expenses,supplierPayments,cashOutflows]=await Promise.all([
   prisma.expense.findMany({where:expenseWhere,include:{supplier:{select:{name:true}}},orderBy:{expenseDate:'desc'}}),
   prisma.supplierPayment.findMany({where:paymentWhere,include:{supplier:{select:{name:true}}},orderBy:{paidAt:'desc'}}),
   prisma.cashMovement.findMany({where:movementWhere,include:{session:{select:{id:true}}},orderBy:{createdAt:'desc'}}),
  ]);
  const entries=[
   ...expenses.map(row=>({...row,sourceType:'EXPENSE',expenseDate:row.expenseDate,category:row.category,description:row.description,amount:row.amount,paymentMethod:row.paymentMethod,notes:row.notes})),
   ...supplierPayments.map(row=>({id:row.id,branchId:row.branchId,supplierId:row.supplierId,sourceType:'SUPPLIER_PAYMENT',expenseDate:row.paidAt,category:'Supplier payment',description:`Payment to ${row.supplier.name}`,amount:row.amount,paymentMethod:row.paymentMethod,notes:[row.reference?`Reference: ${row.reference}`:'',row.notes].filter(Boolean).join(' · '),supplier:row.supplier})),
   ...cashOutflows.map(row=>({id:row.id,sourceType:'CASH_OUTFLOW',expenseDate:row.createdAt,category:'Cash paid out',description:row.reason,amount:row.amount,paymentMethod:'CASH',notes:'Cash management drawer movement'})),
  ].sort((a,b)=>new Date(b.expenseDate).getTime()-new Date(a.expenseDate).getTime());
  const total=entries.reduce((sum,row)=>sum.add(row.amount),new Prisma.Decimal(0));
  const byCategoryMap=new Map<string,{category:string;_sum:{amount:Prisma.Decimal};_count:{_all:number}}>();
  for(const row of entries){const current=byCategoryMap.get(row.category)||{category:row.category,_sum:{amount:new Prisma.Decimal(0)},_count:{_all:0}};current._sum.amount=current._sum.amount.add(row.amount);current._count._all++;byCategoryMap.set(row.category,current)}
  response.json({expenses:entries,summary:{total:total.toFixed(2),count:entries.length,byCategory:[...byCategoryMap.values()].sort((a,b)=>b._sum.amount.comparedTo(a._sum.amount))}});
 }catch(error){next(error)}
});
 app.post('/api/expenses',requireSameOrigin,requireSession,async(request,response,next)=>{const parsed=z.object({branchId:z.string().min(1),category:z.string().trim().min(2).max(80),description:z.string().trim().min(2).max(200),amount:moneyText,paymentMethod:z.enum(['CASH','BANK']).default('CASH'),expenseDate:z.string().datetime().optional(),notes:z.string().trim().max(500).default(''),supplierId:z.string().min(1).optional()}).safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Enter a category, description, amount, and payment method.'}});try{const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('expenses.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot record expenses at this branch.'}});const expense=await prisma.expense.create({data:{...parsed.data,amount:new Prisma.Decimal(parsed.data.amount),expenseDate:parsed.data.expenseDate?new Date(parsed.data.expenseDate):new Date(),supplierId:parsed.data.supplierId||null},include:{supplier:{select:{name:true}}}});await prisma.auditLog.create({data:{branchId:expense.branchId,userId:auth.user.id,action:'EXPENSE_RECORDED',details:{expenseId:expense.id,amount:expense.amount.toString(),paymentMethod:expense.paymentMethod}}});response.status(201).json({expense})}catch(error){next(error)}});

app.get('/api/deliveries',requireSession,async(request,response,next)=>{const branchId=String(request.query.branchId??'');const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,branchId);if(!membership||!rolePermissions[membership.role].includes('delivery.read'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot view branch deliveries.'}});try{const where:Prisma.DeliveryAssignmentWhereInput={order:{branchId,type:OrderType.DELIVERY},...(membership.role===StaffRole.DELIVERY?{staffId:auth.user.id}:{})};const deliveries=await prisma.deliveryAssignment.findMany({where,include:{staff:{select:{id:true,name:true}},history:{orderBy:{createdAt:'desc'},take:5},order:{include:{items:true,customer:true,payments:{select:{id:true,amount:true,method:true,createdAt:true,recordedById:true,cashSessionId:true}}}}},orderBy:{createdAt:'desc'},take:100});const orderIds=deliveries.map(delivery=>delivery.orderId);const submitted=orderIds.length?await prisma.auditLog.findMany({where:{branchId,action:'DELIVERY_CASH_SUBMITTED',orderId:{in:orderIds}},select:{details:true}}):[];const submittedByPayment=new Map(submitted.map(log=>{const details=log.details as {paymentId?:string;destination?:string}|null;return [details?.paymentId??'',details?.destination??'BRANCH'] as const}));response.json({deliveries:deliveries.map(delivery=>({...delivery,driverCashPayments:delivery.order.payments.filter(payment=>payment.recordedById===auth.user.id&&payment.method==='CASH'&&!payment.cashSessionId).map(payment=>({...payment,submitted:submittedByPayment.has(payment.id),destination:submittedByPayment.get(payment.id)}))}))})}catch(error){next(error)}});
app.post('/api/deliveries/:id/cash-submit',requireSameOrigin,requireSession,async(request,response,next)=>{const parsed=z.object({branchId:z.string().min(1),paymentId:z.string().min(1),destination:z.enum(['MANAGER','BRANCH']).default('BRANCH'),receivedBy:z.string().trim().max(120).default('')}).safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Choose where the collected cash was handed over.'}});try{const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,parsed.data.branchId);if(!membership||membership.role!==StaffRole.DELIVERY)return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'Only the assigned delivery staff can submit collected delivery cash.'}});const assignment=await prisma.deliveryAssignment.findFirst({where:{id:String(request.params.id),staffId:auth.user.id,order:{branchId:parsed.data.branchId,type:OrderType.DELIVERY}},include:{order:{include:{payments:true}}}});if(!assignment)return response.status(404).json({error:{code:'DELIVERY_NOT_FOUND',message:'This delivery is not assigned to you.'}});const payment=assignment.order.payments.find(item=>item.id===parsed.data.paymentId&&item.recordedById===auth.user.id&&item.method==='CASH'&&!item.cashSessionId);if(!payment)return response.status(404).json({error:{code:'DELIVERY_CASH_NOT_FOUND',message:'Collected delivery cash was not found.'}});const duplicate=await prisma.auditLog.findFirst({where:{branchId:parsed.data.branchId,orderId:assignment.orderId,action:'DELIVERY_CASH_SUBMITTED',details:{path:['paymentId'],equals:payment.id}}});if(duplicate)return response.status(200).json({submitted:true,replayed:true});await prisma.auditLog.create({data:{branchId:parsed.data.branchId,userId:auth.user.id,orderId:assignment.orderId,action:'DELIVERY_CASH_SUBMITTED',details:{deliveryId:assignment.id,paymentId:payment.id,amount:payment.amount.toString(),destination:parsed.data.destination,receivedBy:parsed.data.receivedBy||null}}});response.status(201).json({submitted:true,paymentId:payment.id,destination:parsed.data.destination,receivedBy:parsed.data.receivedBy||null})}catch(error){next(error)}});
app.patch('/api/deliveries/:id',requireSameOrigin,requireSession,async(request,response,next)=>{const parsed=z.object({branchId:z.string().min(1),staffId:z.string().min(1).nullable().optional(),status:z.enum(['UNASSIGNED','ASSIGNED','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED','FAILED']).optional(),note:z.string().trim().max(300).default('')}).refine(value=>Boolean(value.status)||value.staffId!==undefined).safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Choose a delivery status or staff member.'}});try{const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('delivery.read'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot update this delivery.'}});const assignment=await prisma.deliveryAssignment.findFirst({where:{id:String(request.params.id),order:{branchId:parsed.data.branchId}},include:{order:true}});if(!assignment)return response.status(404).json({error:{code:'DELIVERY_NOT_FOUND',message:'Delivery was not found.'}});const manager=rolePermissions[membership.role].includes('settings.manage');if(parsed.data.staffId!==undefined){if(!manager)return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'Only a manager can assign delivery staff.'}});if(parsed.data.staffId){const staff=await prisma.branchMembership.findFirst({where:{branchId:parsed.data.branchId,userId:parsed.data.staffId,active:true,role:StaffRole.DELIVERY}});if(!staff)return response.status(400).json({error:{code:'INVALID_DELIVERY_STAFF',message:'Choose an active delivery staff member from this branch.'}})}}if(parsed.data.status&&membership.role===StaffRole.DELIVERY&&assignment.staffId!==auth.user.id)return response.status(403).json({error:{code:'DELIVERY_NOT_ASSIGNED',message:'This delivery is not assigned to you.'}});if(parsed.data.status&&!['UNASSIGNED','ASSIGNED'].includes(parsed.data.status)&&assignment.order.status!==OrderStatus.READY)return response.status(409).json({error:{code:'ORDER_NOT_READY',message:'The kitchen must mark this order Ready before delivery status can be updated.'}});if(parsed.data.status==='FAILED'&&parsed.data.note.length<3)return response.status(400).json({error:{code:'FAILED_REASON_REQUIRED',message:'Enter a reason for the failed delivery.'}});const status=parsed.data.status??(parsed.data.staffId?'ASSIGNED':'UNASSIGNED');const result=await prisma.$transaction(async tx=>{const updated=await tx.deliveryAssignment.update({where:{id:assignment.id},data:{...(parsed.data.staffId!==undefined?{staffId:parsed.data.staffId,assignedAt:parsed.data.staffId?new Date():null}:{}),...(parsed.data.status?{status,deliveredAt:status==='DELIVERED'?new Date():undefined,failedReason:status==='FAILED'?parsed.data.note:null}:{})},include:{staff:{select:{id:true,name:true}},order:{include:{items:true}}}});if(parsed.data.status){await tx.deliveryStatusHistory.create({data:{assignmentId:assignment.id,status,note:parsed.data.note}});if(status==='DELIVERED')await tx.order.update({where:{id:assignment.orderId},data:{status:OrderStatus.COMPLETED}})}await tx.auditLog.create({data:{branchId:parsed.data.branchId,userId:auth.user.id,orderId:assignment.orderId,action:'DELIVERY_UPDATED',details:{deliveryId:assignment.id,status,staffId:updated.staffId}}});return updated});if(parsed.data.status&&result.order.customerId)publishCustomerEvent(result.order.customerId,'delivery.changed',{orderNumber:result.order.number,status:result.status});publishBranchEvent(parsed.data.branchId,'orders.changed',{orderNumber:result.order.number,deliveryStatus:result.status});response.json({delivery:result})}catch(error){next(error)}});

app.get('/api/settings/branch',requireSession,async(request,response,next)=>{const branchId=String(request.query.branchId??'');const membership=branchMembership(request,branchId);if(!membership||!rolePermissions[membership.role].includes('settings.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot view branch settings.'}});try{const branch=await prisma.branch.findUnique({where:{id:branchId},include:{restaurant:true}});if(!branch)return response.status(404).json({error:{code:'BRANCH_NOT_FOUND',message:'Branch was not found.'}});response.json({branch})}catch(error){next(error)}});

app.patch('/api/settings/restaurant',requireSameOrigin,requireSession,async(request,response,next)=>{const parsed=z.object({branchId:z.string().min(1),name:z.string().trim().min(2).max(120),title:z.string().trim().min(2).max(120)}).safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Restaurant name and title must be between 2 and 120 characters.'}});try{const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('settings.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot edit restaurant settings.'}});const branch=await prisma.branch.findUnique({where:{id:parsed.data.branchId},select:{restaurantId:true}});if(!branch)return response.status(404).json({error:{code:'BRANCH_NOT_FOUND',message:'Branch was not found.'}});const restaurant=await prisma.restaurant.update({where:{id:branch.restaurantId},data:{name:parsed.data.name,title:parsed.data.title}});response.json({restaurant})}catch(error){next(error)}});
app.get('/api/branch/config',requireSession,async(request,response,next)=>{const branchId=String(request.query.branchId??'');if(!branchMembership(request,branchId))return response.status(403).json({error:{code:'BRANCH_FORBIDDEN',message:'You do not have access to this branch.'}});try{const branch=await prisma.branch.findUnique({where:{id:branchId},select:{id:true,name:true,timezone:true,currency:true,taxRate:true}});if(!branch)return response.status(404).json({error:{code:'BRANCH_NOT_FOUND',message:'Restaurant branch was not found.'}});response.json({branch})}catch(error){next(error)}});
app.patch('/api/settings/branch',requireSameOrigin,requireSession,async(request,response,next)=>{const parsed=z.object({branchId:z.string().min(1),name:z.string().trim().min(2).max(120),timezone:z.string().trim().min(1).max(80),currency:z.string().trim().length(3),taxRate:z.string().regex(/^\d{1,2}(?:\.\d{1,2})?$/).refine(value=>Number(value)<=30),printFormat:z.enum(['THERMAL','A4']).optional(),logoData:z.string().max(2_200_000).nullable().optional().refine(value=>value==null||/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)),address:z.string().trim().max(500).nullable().optional(),deliveryOriginLat:z.number().min(-90).max(90).nullable().optional(),deliveryOriginLon:z.number().min(-180).max(180).nullable().optional(),phone:z.string().trim().max(40).nullable().optional(),email:z.union([z.string().trim().email().max(254),z.literal('')]).nullable().optional()}).refine(value=>(value.deliveryOriginLat==null)===(value.deliveryOriginLon==null),{message:'Set both delivery origin coordinates together.'}).safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Check branch details, delivery origin coordinates, print format, contact information, and uploaded logo.'}});try{const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('settings.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You cannot edit branch settings.'}});const branch=await prisma.branch.update({where:{id:parsed.data.branchId},data:{name:parsed.data.name,timezone:parsed.data.timezone,currency:parsed.data.currency.toUpperCase(),taxRate:new Prisma.Decimal(parsed.data.taxRate),...(parsed.data.printFormat!==undefined?{printFormat:parsed.data.printFormat}:{}),...(parsed.data.logoData!==undefined?{logoData:parsed.data.logoData}:{}),...(parsed.data.address!==undefined?{address:parsed.data.address||null}:{}),...(parsed.data.deliveryOriginLat!==undefined?{deliveryOriginLat:parsed.data.deliveryOriginLat,deliveryOriginLon:parsed.data.deliveryOriginLon??null}:{}),...(parsed.data.phone!==undefined?{phone:parsed.data.phone||null}:{}),...(parsed.data.email!==undefined?{email:parsed.data.email||null}:{})}});await prisma.auditLog.create({data:{branchId:branch.id,userId:auth.user.id,action:'BRANCH_SETTINGS_UPDATED',details:{timezone:branch.timezone,currency:branch.currency,taxRate:branch.taxRate.toString(),printFormat:branch.printFormat,logoUpdated:parsed.data.logoData!==undefined,contactDetailsUpdated:parsed.data.address!==undefined||parsed.data.phone!==undefined||parsed.data.email!==undefined,deliveryOriginUpdated:parsed.data.deliveryOriginLat!==undefined}}});response.json({branch})}catch(error){next(error)}});

app.get('/api/reports/summary', requireSession, requireBranchPermission('reports.read'), async (request, response, next) => {
  const parsed = z.object({ branchId: z.string().min(1), from: z.string().datetime().optional(), to: z.string().datetime().optional() }).safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Choose a valid branch and date range.' } });
  try {
    const { branchId, from, to } = parsed.data;
    const createdAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };
    const where = { branchId, createdAt, status:{not:OrderStatus.CANCELLED} };
    const expenseWhere={branchId,expenseDate:{...(from?{gte:new Date(from)}:{}),...(to?{lte:new Date(to)}:{})}};
    const [count, totals, byType, byStatus, paidOrders, paidTotals, expenses, expensesByCategory] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.aggregate({ where, _sum: { total: true }, _avg: { total: true } }),
      prisma.order.groupBy({ by: ['type'], where, _count: { _all: true }, _sum: { total: true } }),
      prisma.order.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.order.count({ where: { ...where, paymentStatus: PaymentStatus.PAID } }),
      prisma.order.aggregate({where:{...where,paymentStatus:PaymentStatus.PAID},_sum:{total:true}}),
      prisma.expense.aggregate({where:expenseWhere,_sum:{amount:true},_count:{_all:true}}),
      prisma.expense.groupBy({by:['category'],where:expenseWhere,_sum:{amount:true},_count:{_all:true},orderBy:{_sum:{amount:'desc'}}}),
    ]);
    response.json({ summary: { count, grossSales: totals._sum.total ?? 0, paidSales:paidTotals._sum.total??0, averageOrderValue: totals._avg.total ?? 0, paidOrders, unpaidOrders: count - paidOrders, byType, byStatus,expenses:expenses._sum.amount??0,expenseCount:expenses._count._all,expensesByCategory } });
  } catch (error) { next(error); }
});

app.get('/api/reports/dashboard',requireSession,requireBranchPermission('reports.read'),async(request,response,next)=>{
  try{
    const branchId=String(request.query.branchId??process.env.DEMO_BRANCH_ID??'demo-indiranagar');
    const since24=new Date(Date.now()-24*60*60_000),since7=new Date(Date.now()-7*24*60*60_000);
    const [todayCount,todaySales,paidCount,activeOrders,byType,topItems,weeklyOrders,tables,stockItems,deliveries]=await Promise.all([
      prisma.order.count({where:{branchId,createdAt:{gte:since24},status:{not:OrderStatus.CANCELLED}}}),
      prisma.order.aggregate({where:{branchId,createdAt:{gte:since24},paymentStatus:PaymentStatus.PAID},_sum:{total:true}}),
      prisma.order.count({where:{branchId,createdAt:{gte:since24},paymentStatus:PaymentStatus.PAID}}),
      prisma.order.count({where:{branchId,status:{in:[OrderStatus.PLACED,OrderStatus.PREPARING,OrderStatus.READY]}}}),
      prisma.order.groupBy({by:['type'],where:{branchId,createdAt:{gte:since24}},_count:{_all:true}}),
      prisma.orderItem.groupBy({by:['itemName'],where:{order:{branchId,createdAt:{gte:since7},status:{not:OrderStatus.CANCELLED}}},_sum:{quantity:true,lineTotal:true},orderBy:{_sum:{quantity:'desc'}},take:5}),
      prisma.order.findMany({where:{branchId,createdAt:{gte:since7},paymentStatus:PaymentStatus.PAID},select:{createdAt:true,total:true}}),
      prisma.diningTable.groupBy({by:['status'],where:{branchId},_count:{_all:true}}),
      prisma.inventoryItem.findMany({where:{branchId,active:true},select:{quantity:true,reorderLevel:true}}),
      prisma.deliveryAssignment.count({where:{order:{branchId},status:{in:['ASSIGNED','PICKED_UP','OUT_FOR_DELIVERY']}}}),
    ]);
    const days=Array.from({length:7},(_,index)=>{const day=new Date(Date.now()-(6-index)*24*60*60_000);const key=day.toISOString().slice(0,10);return{day:day.toLocaleDateString('en-IN',{weekday:'short'}),sales:weeklyOrders.filter(order=>order.createdAt.toISOString().slice(0,10)===key).reduce((sum,order)=>sum+Number(order.total),0)}});
    response.json({dashboard:{todayCount,paidCount,grossSales:Number(todaySales._sum.total??0),activeOrders,byType,topItems:topItems.map(item=>({name:item.itemName,quantity:item._sum.quantity??0,sales:item._sum.lineTotal??0})),days,tables,lowStock:stockItems.filter(item=>item.quantity.lte(item.reorderLevel)).length,deliveries}});
  }catch(error){next(error)}
});

app.get('/api/audit', requireSession, async (request, response, next) => {
  const branchId = String(request.query.branchId ?? '');
  const membership = branchMembership(request, branchId);
  if (!membership || !rolePermissions[membership.role].includes('audit.read')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have access to audit history for this branch.' } });
  try {
    const take = Math.min(Math.max(Number(request.query.limit ?? 100), 1), 200);
    const events = await prisma.auditLog.findMany({ where: { branchId }, include: { user: { select: { name: true, email: true } } }, orderBy: { createdAt: 'desc' }, take });
    response.json({ events });
  } catch (error) { next(error); }
});

const orderStatusInput = z.object({ branchId: z.string().min(1), status: z.nativeEnum(OrderStatus), reason: z.string().trim().max(300).default('') });
const orderTransitions: Partial<Record<OrderStatus, OrderStatus[]>> = {
  DRAFT: [OrderStatus.PLACED, OrderStatus.CANCELLED],
  PLACED: [OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.CANCELLED],
  PREPARING: [OrderStatus.READY, OrderStatus.CANCELLED],
  READY: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
};
app.patch('/api/orders/:number/status', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = orderStatusInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Choose a valid next order status.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    const membership = branchMembership(request, parsed.data.branchId);
    if (!membership) return response.status(403).json({ error: { code: 'BRANCH_FORBIDDEN', message: 'You do not have access to this branch.' } });
    if (!rolePermissions[membership.role].includes('orders.status.update')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to update order status.' } });
    if (parsed.data.status === OrderStatus.CANCELLED && (!rolePermissions[membership.role].includes('settings.manage') || parsed.data.reason.length < 3)) return response.status(403).json({ error: { code: 'CANCELLATION_FORBIDDEN', message: 'A manager or owner must provide a cancellation reason.' } });
    const number = Number(request.params.number);
    if (!Number.isSafeInteger(number) || number < 1) return response.status(400).json({ error: { code: 'INVALID_ORDER', message: 'Order number is invalid.' } });
    const current = await prisma.order.findFirst({ where: { number, branchId: parsed.data.branchId }, include: { items: true } });
    if (!current) return response.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: 'Order was not found.' } });
    if (!orderTransitions[current.status]?.includes(parsed.data.status)) return response.status(409).json({ error: { code: 'INVALID_STATUS_TRANSITION', message: `Cannot move an order from ${current.status} to ${parsed.data.status}.` } });
    let refundAmount = new Prisma.Decimal(0);let refundSession:{id:string}|null=null;
    if(parsed.data.status===OrderStatus.CANCELLED&&current.paymentStatus!=='UNPAID'){
      const payments=await prisma.payment.findMany({where:{orderId:current.id},select:{method:true,amount:true}});
      if(payments.some(payment=>payment.method!=='CASH'))return response.status(409).json({error:{code:'NON_CASH_REFUND_UNSUPPORTED',message:'This order includes a non-cash payment. Refund it through the original payment provider before cancelling.'}});
      refundAmount=payments.reduce((sum,payment)=>sum.add(payment.amount),new Prisma.Decimal(0));
      if(refundAmount.lte(0)||current.paymentStatus==='REFUNDED')return response.status(409).json({error:{code:'REFUND_NOT_AVAILABLE',message:'There is no refundable payment on this order.'}});
      refundSession=await prisma.cashSession.findFirst({where:{branchId:current.branchId,openedById:auth.user.id,closedAt:null},select:{id:true}});
      if(!refundSession)return response.status(409).json({error:{code:'CASH_SESSION_REQUIRED',message:'Open your cash register before cancelling this paid order. The refund will be recorded as cash paid out.'}});
    }
    let unconfiguredRecipes: string[] = [];
    const updated = await prisma.$transaction(async tx => {
      const change = await tx.order.updateMany({ where: { id: current.id, status: current.status, paymentStatus:current.paymentStatus }, data: { status: parsed.data.status, ...(refundAmount.gt(0)?{paymentStatus:PaymentStatus.REFUNDED}:{}) } });
      if (!change.count) throw new Error('ORDER_STATUS_CONFLICT');
      if (parsed.data.status === OrderStatus.READY) {
        const productionOrder = await tx.order.findUniqueOrThrow({ where: { id: current.id }, include: { items: true } });
        const menuItemIds = [...new Set(productionOrder.items.map(item => item.menuItemId).filter((id): id is string => Boolean(id)))];
        const recipeLines = await tx.menuRecipeLine.findMany({ where: { menuItemId: { in: menuItemIds } }, include: { inventoryItem: { select: { id: true, name: true, unit: true } } } });
        const recipeLinesByMenu = new Map<string, typeof recipeLines>();
        for (const line of recipeLines) recipeLinesByMenu.set(line.menuItemId, [...(recipeLinesByMenu.get(line.menuItemId) || []), line]);
        unconfiguredRecipes = [...new Set(productionOrder.items.filter(item => !item.menuItemId || !recipeLinesByMenu.get(item.menuItemId)?.length).map(item => item.itemName))];
        const requirements = new Map<string, { itemName: string; unit: string; quantity: Prisma.Decimal }>();
        for (const orderItem of productionOrder.items) for (const recipeLine of recipeLinesByMenu.get(orderItem.menuItemId!) || []) {
          const required = recipeLine.quantity.mul(orderItem.quantity);
          const existing = requirements.get(recipeLine.inventoryItemId);
          requirements.set(recipeLine.inventoryItemId, { itemName: recipeLine.inventoryItem.name, unit: recipeLine.inventoryItem.unit, quantity: existing ? existing.quantity.add(required) : required });
        }
        const dishSummary = productionOrder.items.map(item => `${item.quantity} × ${item.itemName}`).join(', ');
        const consumed: Array<{ inventoryItemId: string; name: string; quantity: string; unit: string }> = [];
        for (const [inventoryItemId, requirement] of requirements) {
          const stock = await tx.inventoryItem.findUnique({ where: { id: inventoryItemId }, select: { quantity: true, active: true } });
          if (!stock?.active || stock.quantity.lt(requirement.quantity)) throw new Error(`STOCK_SHORT|${requirement.itemName}|${stock?.quantity.toString() ?? '0'}|${requirement.unit}|${requirement.quantity.toString()}`);
          const nextQuantity = stock.quantity.sub(requirement.quantity);
          const changedStock = await tx.inventoryItem.updateMany({ where: { id: inventoryItemId, quantity: stock.quantity, active: true }, data: { quantity: nextQuantity } });
          if (!changedStock.count) throw new Error('STOCK_CONFLICT');
          await tx.stockMovement.create({ data: { inventoryItemId, type: 'PRODUCTION_ISSUE', quantity: requirement.quantity.negated(), reason: `BOM issue for Order #${current.number}: ${dishSummary}`, reference: current.id } });
          consumed.push({ inventoryItemId, name: requirement.itemName, quantity: requirement.quantity.toString(), unit: requirement.unit });
        }
        await tx.auditLog.create({ data: { branchId: current.branchId, userId: auth.user.id, orderId: current.id, action: 'RECIPE_STOCK_CONSUMED', details: { orderNumber: current.number, dishes: dishSummary, ingredients: consumed } } });
      }
      if(refundAmount.gt(0)&&refundSession){const refund=await tx.refund.create({data:{orderId:current.id,amount:refundAmount,method:'CASH',reason:parsed.data.reason,recordedById:auth.user.id,cashSessionId:refundSession.id}});await tx.cashMovement.create({data:{sessionId:refundSession.id,type:'OUT',amount:refundAmount,reason:`Refund for order #${current.number}: ${parsed.data.reason}`}});await tx.auditLog.create({data:{branchId:current.branchId,userId:auth.user.id,orderId:current.id,action:'ORDER_CANCELLED_REFUNDED',details:{refundId:refund.id,amount:refundAmount.toFixed(2),method:'CASH',reason:parsed.data.reason}}})}else await tx.auditLog.create({ data: { branchId: current.branchId, userId: auth.user.id, orderId: current.id, action: 'ORDER_STATUS_CHANGED', details: { from: current.status, to: parsed.data.status, reason: parsed.data.reason || undefined } } });
      if(parsed.data.status===OrderStatus.CANCELLED&&current.tableSessionId){const remaining=await tx.order.findFirst({where:{tableSessionId:current.tableSessionId,id:{not:current.id},status:{not:OrderStatus.CANCELLED}},select:{id:true}});if(!remaining){await tx.tableSession.updateMany({where:{id:current.tableSessionId,status:'OPEN'},data:{status:'CLOSED',closedAt:new Date()}});await tx.diningTable.updateMany({where:{id:current.tableId!,status:'OCCUPIED'},data:{status:'AVAILABLE'}})}}
      if(current.tableId&&(parsed.data.status===OrderStatus.COMPLETED||parsed.data.status===OrderStatus.CANCELLED)){const openSession=current.tableSessionId?await tx.tableSession.findFirst({where:{id:current.tableSessionId,status:'OPEN'},select:{id:true}}):null;const otherActive=await tx.order.findFirst({where:{tableId:current.tableId,id:{not:current.id},status:{notIn:[OrderStatus.COMPLETED,OrderStatus.CANCELLED]}},select:{id:true}});if(!otherActive&&!openSession)await tx.diningTable.updateMany({where:{id:current.tableId,status:'OCCUPIED'},data:{status:'AVAILABLE'}})}
      return tx.order.findUniqueOrThrow({ where: { id: current.id }, include: { items: true, payments: true } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    response.json({ order: updated, ...(unconfiguredRecipes.length ? { warning: { code: 'MISSING_RECIPE', message: `Order marked ready, but stock was not issued for ${unconfiguredRecipes.join(', ')} because those items do not have recipes.` } } : {}) });
  } catch (error) {
    if (error instanceof Error && error.message === 'ORDER_STATUS_CONFLICT') return response.status(409).json({ error: { code: 'ORDER_STATUS_CONFLICT', message: 'Another staff member changed this order. Refresh the list and retry.' } });
    if (error instanceof Error && error.message.startsWith('STOCK_SHORT|')) { const [,name,available,unit,required]=error.message.split('|'); return response.status(409).json({ error: { code: 'INSUFFICIENT_RECIPE_STOCK', message: `Not enough ${name} in stock. Need ${required} ${unit}; ${available} ${unit} available.` } }); }
    if (error instanceof Error && error.message === 'STOCK_CONFLICT') return response.status(409).json({ error: { code: 'STOCK_CONFLICT', message: 'Stock changed while this order was being completed. Refresh and try again.' } });
    if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2034')return response.status(409).json({error:{code:'ORDER_STATUS_CONFLICT',message:'Another payment or order update is in progress. Refresh and try again.'}});
    next(error);
  }
});

const editOrderInput=z.object({branchId:z.string().min(1),notes:z.string().trim().max(1000).default(''),items:z.array(z.object({menuItemId:z.string().min(1),quantity:z.number().int().min(1).max(50),taxRate:z.number().min(0).max(30).optional(),notes:z.string().trim().max(500).default('')})).min(1).max(50)});
app.patch('/api/orders/:number',requireSameOrigin,requireSession,async(request,response,next)=>{
 const parsed=editOrderInput.safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Add at least one valid item to the order.'}});
 try{
  const auth=(request as AuthRequest).auth!;const membership=branchMembership(request,parsed.data.branchId);if(!membership||!rolePermissions[membership.role].includes('settings.manage'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'Only a manager or owner can modify an order.'}});
  const number=Number(request.params.number);if(!Number.isSafeInteger(number)||number<1)return response.status(400).json({error:{code:'INVALID_ORDER',message:'Order number is invalid.'}});
  const current=await prisma.order.findFirst({where:{number,branchId:parsed.data.branchId},include:{items:true}});if(!current)return response.status(404).json({error:{code:'ORDER_NOT_FOUND',message:'Order was not found.'}});
  if(current.paymentStatus!=='UNPAID'||(current.status!==OrderStatus.PLACED&&current.status!==OrderStatus.PREPARING))return response.status(409).json({error:{code:'ORDER_NOT_EDITABLE',message:'Only unpaid orders that are still being prepared can be modified.'}});
  const menuItems=await prisma.menuItem.findMany({where:{branchId:current.branchId,id:{in:parsed.data.items.map(item=>item.menuItemId)},available:true,deletedAt:null}});if(menuItems.length!==new Set(parsed.data.items.map(item=>item.menuItemId)).size)return response.status(400).json({error:{code:'INVALID_MENU_ITEM',message:'One or more selected menu items are unavailable.'}});
  const branch=await prisma.branch.findUniqueOrThrow({where:{id:current.branchId},select:{taxRate:true}});const byId=new Map(menuItems.map(item=>[item.id,item]));const lines=parsed.data.items.map(item=>{const product=byId.get(item.menuItemId)!;return{menuItemId:product.id,itemName:product.name,quantity:item.quantity,unitPrice:product.price,lineTotal:product.price.mul(item.quantity),taxRate:new Prisma.Decimal(item.taxRate??Number(branch.taxRate)),notes:item.notes}});
  const subtotal=lines.reduce((sum,line)=>sum.add(line.lineTotal),new Prisma.Decimal(0));if(current.discount.gt(subtotal))return response.status(400).json({error:{code:'DISCOUNT_EXCEEDS_SUBTOTAL',message:'The current discount is greater than the edited subtotal.'}});
  const taxable=subtotal.sub(current.discount);const tax=orderTax(lines,current.discount,current.deliveryFee,new Prisma.Decimal(branch.taxRate));const total=taxable.add(current.deliveryFee).add(tax);
  const updated=await prisma.$transaction(async tx=>{const changed=await tx.order.updateMany({where:{id:current.id,updatedAt:current.updatedAt,paymentStatus:'UNPAID',status:{in:[OrderStatus.PLACED,OrderStatus.PREPARING]}},data:{notes:parsed.data.notes,subtotal,taxAmount:tax,total}});if(!changed.count)throw new Error('ORDER_EDIT_CONFLICT');await tx.orderItem.deleteMany({where:{orderId:current.id}});await tx.orderItem.createMany({data:lines.map(line=>({orderId:current.id,...line}))});await tx.auditLog.create({data:{branchId:current.branchId,userId:auth.user.id,orderId:current.id,action:'ORDER_MODIFIED',details:{itemCount:lines.length,total:total.toString()}}});return tx.order.findUniqueOrThrow({where:{id:current.id},include:{items:true,table:{select:{number:true}}}})},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});response.json({order:updated});
 }catch(error){if(error instanceof Error&&error.message==='ORDER_EDIT_CONFLICT')return response.status(409).json({error:{code:'ORDER_EDIT_CONFLICT',message:'This order changed or was paid while you were editing it. Refresh and retry.'}});next(error)}
});

const orderInput = z.object({
  branchId: z.string().min(1).default(process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar'),
  type: z.nativeEnum(OrderType),
  customerId: z.string().min(1).optional(),
  customerName: z.string().trim().min(1).max(120).default('Walk-in Guest'),
  deliveryPhone: z.string().trim().max(40).optional(),
  deliveryAddress: z.string().trim().max(500).optional(),
  deliveryInstructions: z.string().trim().max(500).optional(),
  deliveryFee: moneyText.default('0.00'),
  tableId: z.string().optional(),
  notes: z.string().max(1000).default(''),
  discount: z.string().regex(/^\d+(?:\.\d{1,2})?$/).default('0.00'),
  items: z.array(z.object({ menuItemId: z.string().min(1), quantity: z.number().int().min(1).max(50), taxRate: z.number().min(0).max(30).optional(), notes: z.string().max(500).default('') })).min(1).max(50),
}).superRefine((value,context)=>{if(value.type===OrderType.DELIVERY&&(!value.deliveryPhone?.trim()||!value.deliveryAddress?.trim()))context.addIssue({code:'custom',path:['deliveryAddress'],message:'Delivery orders require a contact phone and address.'})});

app.post('/api/orders', requireSameOrigin, requireSession, requireBranchPermission('orders.create'), async (request, response, next) => {
  const parsed = orderInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten() } });
  const key = request.header('Idempotency-Key');
  if (!key || key.length < 12 || key.length > 200) return response.status(400).json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send a unique Idempotency-Key header.' } });
  try {
    const existing = await prisma.order.findUnique({ where: { idempotencyKey: key }, include: { items: true } });
    if (existing) return response.status(200).json({ order: existing, replayed: true });
    const input = parsed.data;
    if (input.type === OrderType.QUICK_BILL && input.tableId) return response.status(400).json({ error: { code: 'QUICK_BILL_NO_TABLE', message: 'Quick bills cannot be assigned to a dining table.' } });
    const requestedDiscount = new Prisma.Decimal(input.discount);
    const membership = branchMembership(request, input.branchId);
    if (!membership) return response.status(403).json({ error: { code: 'BRANCH_FORBIDDEN', message: 'You do not have access to this branch.' } });
    if (requestedDiscount.gt(0) && !rolePermissions[membership.role].includes('settings.manage')) return response.status(403).json({ error: { code: 'DISCOUNT_FORBIDDEN', message: 'Only a manager or owner can apply manual discounts.' } });
    const customer = input.customerId ? await prisma.customer.findFirst({ where: { id: input.customerId, branchId: input.branchId } }) : null;
    if (input.customerId && !customer) return response.status(400).json({ error: { code: 'INVALID_CUSTOMER', message: 'Customer is not available at this branch.' } });
    const products = await prisma.menuItem.findMany({ where: { branchId: input.branchId, id: { in: input.items.map(i => i.menuItemId) }, available: true, deletedAt: null } });
    if (products.length !== new Set(input.items.map(i => i.menuItemId)).size) return response.status(400).json({ error: { code: 'INVALID_MENU_ITEM', message: 'One or more items are unavailable at this branch.' } });
    if (input.tableId) {
      const table = await prisma.diningTable.findFirst({ where: { id: input.tableId, branchId: input.branchId } });
      if (!table) return response.status(400).json({ error: { code: 'INVALID_TABLE', message: 'Table is not available at this branch.' } });
      if ((input.type !== OrderType.DINE_IN && input.type !== OrderType.TAKEAWAY) || !['AVAILABLE','RESERVED','OCCUPIED'].includes(table.status)) return response.status(409).json({ error: { code: 'TABLE_NOT_AVAILABLE', message: 'Choose an available or already occupied table for this order.' } });
    }
    const branchSettings = await prisma.branch.findUnique({ where: { id: input.branchId }, select: { taxRate: true } });
    if (!branchSettings) return response.status(404).json({ error: { code: 'BRANCH_NOT_FOUND', message: 'Restaurant branch was not found.' } });
    const byId = new Map(products.map(p => [p.id, p]));
    const lines = input.items.map(i => { const product = byId.get(i.menuItemId)!; const unitPrice = product.price; return { menuItemId: product.id, itemName: product.name, quantity: i.quantity, unitPrice, lineTotal: unitPrice.mul(i.quantity), taxRate: new Prisma.Decimal(i.taxRate ?? Number(branchSettings.taxRate)), notes: i.notes }; });
    const subtotal = lines.reduce((sum, line) => sum.add(line.lineTotal), new Prisma.Decimal(0));
    if (requestedDiscount.gt(subtotal)) return response.status(400).json({ error: { code: 'INVALID_DISCOUNT', message: 'Discount cannot exceed the order subtotal.' } });
    const taxableSubtotal = subtotal.sub(requestedDiscount);
    const deliveryFee = new Prisma.Decimal(input.type === OrderType.DELIVERY ? input.deliveryFee : '0.00');
    const taxAmount = orderTax(lines, requestedDiscount, deliveryFee, new Prisma.Decimal(branchSettings.taxRate));
    const order = await prisma.$transaction(async tx => {
      let tableSessionId:string|undefined;
      if(input.tableId){
        const currentTable=await tx.diningTable.findUniqueOrThrow({where:{id:input.tableId}});
        if(currentTable.status==='OCCUPIED'){
          let session=await tx.tableSession.findFirst({where:{tableId:input.tableId,status:'OPEN'}});
          if(!session){
            session=await tx.tableSession.create({data:{branchId:input.branchId,tableId:input.tableId,customerName:customer?.name??input.customerName}});
            await tx.order.updateMany({where:{tableId:input.tableId,tableSessionId:null,status:{notIn:[OrderStatus.CANCELLED]}},data:{tableSessionId:session.id}});
          }
          tableSessionId=session.id;
        }else{
          const claimed=await tx.diningTable.updateMany({where:{id:input.tableId,branchId:input.branchId,status:{in:['AVAILABLE','RESERVED']}},data:{status:'OCCUPIED'}});if(!claimed.count)throw new Error('TABLE_ALREADY_BUSY');
          const session=await tx.tableSession.create({data:{branchId:input.branchId,tableId:input.tableId,customerName:customer?.name??input.customerName}});tableSessionId=session.id;
        }
      }
      return tx.order.create({data:{branchId:input.branchId,type:input.type,tableId:input.tableId,tableSessionId,customerId:customer?.id,customerName:customer?.name??input.customerName,deliveryPhone:input.deliveryPhone,deliveryAddress:input.deliveryAddress,deliveryInstructions:input.deliveryInstructions,deliveryFee,notes:input.notes,status:OrderStatus.PLACED,subtotal,taxAmount,discount:requestedDiscount,total:taxableSubtotal.add(deliveryFee).add(taxAmount),idempotencyKey:key,items:{create:lines},...(input.type===OrderType.DELIVERY?{deliveryAssignment:{create:{status:'UNASSIGNED'}}}:{})},include:{items:true,table:{select:{number:true}},tableSession:true}})
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    if (order.tableId) publishBranchEvent(input.branchId, 'tables.changed', { tableId: order.tableId, orderNumber: order.number });
    publishBranchEvent(input.branchId, 'orders.changed', { orderNumber: order.number });
    response.status(201).json({ order, replayed: false });
  } catch (error) {
    if (error instanceof Error && error.message === 'TABLE_ALREADY_BUSY') return response.status(409).json({ error: { code: 'TABLE_NOT_AVAILABLE', message: 'Another staff member took this table. Refresh and choose another.' } });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const replay = await prisma.order.findUnique({ where: { idempotencyKey: key }, include: { items: true } });
      if (replay) return response.status(200).json({ order: replay, replayed: true });
    }
    next(error);
  }
});

const cashPaymentInput = z.object({
  branchId: z.string().min(1),
  method: z.enum(['CASH','BANK_TRANSFER']),
  amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
  cashReceived: z.string().regex(/^\d+(?:\.\d{1,2})?$/).optional(),
});

function canManageCash(request: Request, branchId: string) {
  const membership = branchMembership(request, branchId);
  return Boolean(membership && rolePermissions[membership.role].includes('cash.manage'));
}
async function cashExpected(tx: Prisma.TransactionClient, sessionId: string, openingFloat: Prisma.Decimal) {
  const [payments, movements] = await Promise.all([
    tx.payment.aggregate({ where: { cashSessionId: sessionId, method: 'CASH' }, _sum: { amount: true } }),
    tx.cashMovement.findMany({ where: { sessionId }, select: { type: true, amount: true } }),
  ]);
  const movementTotal = movements.reduce((sum, movement) => movement.type === 'IN' ? sum.add(movement.amount) : sum.sub(movement.amount), new Prisma.Decimal(0));
  return openingFloat.add(payments._sum.amount ?? new Prisma.Decimal(0)).add(movementTotal);
}

app.get('/api/cash/session', requireSession, async (request, response, next) => {
  try {
    const auth = (request as AuthRequest).auth!;
    const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
    const membership = branchMembership(request, branchId);
    if (!membership || !rolePermissions[membership.role].includes('cash.read')) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to view cash sessions.' } });
    let session = await prisma.cashSession.findFirst({ where: { branchId, openedById: auth.user.id, closedAt: null }, include: { openedBy:{select:{name:true}}, movements: { orderBy: { createdAt: 'desc' } } }, orderBy: { openedAt: 'desc' } });
    if(!session&&['OWNER','MANAGER'].includes(membership.role))session=await prisma.cashSession.findFirst({where:{branchId,closedAt:null},include:{openedBy:{select:{name:true}},movements:{orderBy:{createdAt:'desc'}}},orderBy:{openedAt:'desc'}});
    if (!session) return response.json({ session: null });
    const expected = await cashExpected(prisma, session.id, session.openingFloat);
    response.json({ session: { ...session, expectedCash: expected.toFixed(2) } });
  } catch (error) { next(error); }
});

app.get('/api/cash/sessions',requireSession,async(request,response,next)=>{
  try {
    const branchId=String(request.query.branchId??'');
    const membership=branchMembership(request,branchId);
    if(!membership||!rolePermissions[membership.role].includes('cash.read'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You do not have permission to view cash sessions.'}});
    const sessions=await prisma.cashSession.findMany({where:{branchId},include:{openedBy:{select:{name:true}}},orderBy:{openedAt:'desc'},take:100});
    const activeIds=sessions.filter(session=>!session.closedAt).map(session=>session.id);
    const [payments,movements]=activeIds.length?await Promise.all([
      prisma.payment.groupBy({by:['cashSessionId'],where:{cashSessionId:{in:activeIds},method:'CASH'},_sum:{amount:true}}),
      prisma.cashMovement.groupBy({by:['sessionId','type'],where:{sessionId:{in:activeIds}},_sum:{amount:true}}),
    ]):[[],[]];
    const paymentTotals=new Map(payments.flatMap(row=>row.cashSessionId?[[row.cashSessionId,row._sum.amount??new Prisma.Decimal(0)] as const]:[]));
    const movementTotals=new Map<string,Prisma.Decimal>();
    for(const row of movements){const current=movementTotals.get(`${row.sessionId}:${row.type}`)??new Prisma.Decimal(0);movementTotals.set(`${row.sessionId}:${row.type}`,current.add(row._sum.amount??new Prisma.Decimal(0)))}
    const detailed=sessions.map(session=>{
      let expected=session.expectedCash??session.openingFloat;
      if(!session.closedAt){expected=session.openingFloat.add(paymentTotals.get(session.id)??new Prisma.Decimal(0)).add(movementTotals.get(`${session.id}:IN`)??new Prisma.Decimal(0)).sub(movementTotals.get(`${session.id}:OUT`)??new Prisma.Decimal(0))}
      return {...session,expectedCash:expected.toFixed(2)};
    });
    response.json({sessions:detailed});
  }catch(error){next(error)}
});

app.get('/api/cash/day-summary',requireSession,async(request,response,next)=>{
  const parsed=z.object({branchId:z.string().min(1),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).safeParse(request.query);
  if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Choose a valid business date.'}});
  try{
    const branchId=parsed.data.branchId,membership=branchMembership(request,branchId);
    if(!membership||!rolePermissions[membership.role].includes('cash.read'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You do not have permission to view daily balances.'}});
    const branch=await prisma.branch.findUnique({where:{id:branchId},select:{timezone:true}});
    const timezone=branch?.timezone||'Asia/Kolkata';
    const dateKey=parsed.data.date??new Intl.DateTimeFormat('en-CA',{timeZone:timezone}).format(new Date());
    const zonedBoundary=(key:string)=>{const [year,month,day]=key.split('-').map(Number);const target=Date.UTC(year,month-1,day);let guess=target;for(let i=0;i<3;i++){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));const represented=Date.UTC(Number(values.year),Number(values.month)-1,Number(values.day),Number(values.hour),Number(values.minute),Number(values.second));guess+=target-represented;}return new Date(guess)};const start=zonedBoundary(dateKey),nextDay=new Date(Date.UTC(Number(dateKey.slice(0,4)),Number(dateKey.slice(5,7))-1,Number(dateKey.slice(8,10))+1)).toISOString().slice(0,10),end=zonedBoundary(nextDay);
    const salesWhere:Prisma.PaymentWhereInput={order:{branchId},createdAt:{lt:start}};
    const expensesWhere={branchId,expenseDate:{lt:start}};
    const [payments,movements,expenses,supplierPayments,dayMovements,dayPayments,dayExpenses,daySupplierPayments]=await Promise.all([
      prisma.payment.findMany({where:{...salesWhere,method:{in:[PaymentMethod.CASH,PaymentMethod.BANK_TRANSFER,PaymentMethod.UPI,PaymentMethod.CARD]}},include:{order:{select:{number:true,customerName:true}}}}),
      prisma.cashMovement.findMany({where:{session:{branchId},createdAt:{lt:end}},select:{id:true,type:true,amount:true,reason:true,createdAt:true}}),
      prisma.expense.findMany({where:expensesWhere,select:{id:true,amount:true,paymentMethod:true,description:true,category:true,expenseDate:true}}),
      prisma.supplierPayment.findMany({where:{branchId,paidAt:{lt:start}},select:{id:true,amount:true,paymentMethod:true,reference:true,paidAt:true,supplier:{select:{name:true}}}}),
      prisma.cashMovement.findMany({where:{session:{branchId},createdAt:{gte:start,lt:end}},select:{id:true,type:true,amount:true,reason:true,createdAt:true}}),
      prisma.payment.findMany({where:{...salesWhere,method:{in:[PaymentMethod.CASH,PaymentMethod.BANK_TRANSFER,PaymentMethod.UPI,PaymentMethod.CARD]},createdAt:{gte:start,lt:end}},include:{order:{select:{number:true,customerName:true}}}}),
      prisma.expense.findMany({where:{...expensesWhere,expenseDate:{gte:start,lt:end}},select:{id:true,amount:true,paymentMethod:true,description:true,category:true,expenseDate:true}}),
      prisma.supplierPayment.findMany({where:{branchId,paidAt:{gte:start,lt:end}},select:{id:true,amount:true,paymentMethod:true,reference:true,paidAt:true,supplier:{select:{name:true}}}}),
    ]);
    const zero=new Prisma.Decimal(0), isBank=(method:string)=>method!=='CASH';
    const cashPaymentTotal=payments.filter(row=>row.method==='CASH').reduce((sum,row)=>sum.add(row.amount),zero);
    const bankPaymentTotal=payments.filter(row=>isBank(row.method)).reduce((sum,row)=>sum.add(row.amount),zero);
    const cashExpenseTotal=expenses.filter(row=>row.paymentMethod==='CASH').reduce((sum,row)=>sum.add(row.amount),zero);
    const bankExpenseTotal=expenses.filter(row=>row.paymentMethod!=='CASH').reduce((sum,row)=>sum.add(row.amount),zero);
    const cashSupplierPaid=supplierPayments.filter(row=>row.paymentMethod==='CASH').reduce((sum,row)=>sum.add(row.amount),zero);
    const bankSupplierPaid=supplierPayments.filter(row=>row.paymentMethod!=='CASH').reduce((sum,row)=>sum.add(row.amount),zero);
    const cashMovementNet=movements.reduce((sum,row)=>row.type==='IN'?sum.add(row.amount):sum.sub(row.amount),zero);
    const openingCash=cashPaymentTotal.sub(cashExpenseTotal).sub(cashSupplierPaid).add(cashMovementNet);
    const openingBank=bankPaymentTotal.sub(bankExpenseTotal).sub(bankSupplierPaid);
    const cashCreditsList:any[]=[],cashDebitsList:any[]=[],bankCreditsList:any[]=[],bankDebitsList:any[]=[];
    for(const row of dayPayments){const entry={id:row.id,date:row.createdAt,description:`Sale · Order #${row.order.number} · ${row.order.customerName}`,amount:row.amount.toFixed(2)};(row.method==='CASH'?cashCreditsList:bankCreditsList).push(entry)}
    for(const row of dayMovements){const entry={id:row.id,date:row.createdAt,description:row.reason,amount:row.amount.toFixed(2)};(row.type==='IN'?cashCreditsList:cashDebitsList).push(entry)}
    for(const row of dayExpenses){const entry={id:row.id,date:row.expenseDate,description:`${row.category} · ${row.description}`,amount:row.amount.toFixed(2)};(row.paymentMethod==='CASH'?cashDebitsList:bankDebitsList).push(entry)}
    for(const row of daySupplierPayments){const entry={id:row.id,date:row.paidAt,description:`Supplier payment · ${row.supplier.name}${row.reference?` · ${row.reference}`:''}`,amount:row.amount.toFixed(2)};(row.paymentMethod==='CASH'?cashDebitsList:bankDebitsList).push(entry)}
    const total=(rows:any[])=>rows.reduce((sum,row)=>sum.add(new Prisma.Decimal(row.amount)),zero);
    const cashCredits=total(cashCreditsList),bankCredits=total(bankCreditsList),cashDebits=total(cashDebitsList),bankDebits=total(bankDebitsList);
    response.json({summary:{date:dateKey,openingCash:openingCash.toFixed(2),openingBank:openingBank.toFixed(2),cashCredits:cashCredits.toFixed(2),bankCredits:bankCredits.toFixed(2),cashDebits:cashDebits.toFixed(2),bankDebits:bankDebits.toFixed(2),closingCash:openingCash.add(cashCredits).sub(cashDebits).toFixed(2),closingBank:openingBank.add(bankCredits).sub(bankDebits).toFixed(2),cashCreditsList:cashCreditsList.sort((a,b)=>+new Date(a.date)-+new Date(b.date)),cashDebitsList:cashDebitsList.sort((a,b)=>+new Date(a.date)-+new Date(b.date)),bankCreditsList:bankCreditsList.sort((a,b)=>+new Date(a.date)-+new Date(b.date)),bankDebitsList:bankDebitsList.sort((a,b)=>+new Date(a.date)-+new Date(b.date))}});
  }catch(error){next(error)}
});

app.get('/api/cash/range-summary',requireSession,async(request,response,next)=>{
 const parsed=z.object({branchId:z.string().min(1),from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).safeParse(request.query);
 if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Choose a valid cashbook date range.'}});
 try{
  const {branchId,from,to}=parsed.data,membership=branchMembership(request,parsed.data.branchId);
  if(!membership||!rolePermissions[membership.role].includes('cash.read'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You do not have permission to view cashbook entries.'}});
  if(from>to)return response.status(400).json({error:{code:'INVALID_DATE_RANGE',message:'The start date must be on or before the end date.'}});
  const branch=await prisma.branch.findUnique({where:{id:branchId},select:{timezone:true}}),timezone=branch?.timezone||'Asia/Kolkata';
  const zonedBoundary=(key:string)=>{const [year,month,day]=key.split('-').map(Number);const target=Date.UTC(year,month-1,day);let guess=target;for(let i=0;i<3;i++){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));const represented=Date.UTC(Number(values.year),Number(values.month)-1,Number(values.day),Number(values.hour),Number(values.minute),Number(values.second));guess+=target-represented}return new Date(guess)};
  const start=zonedBoundary(from),afterToKey=new Date(Date.UTC(Number(to.slice(0,4)),Number(to.slice(5,7))-1,Number(to.slice(8,10))+1)).toISOString().slice(0,10),end=zonedBoundary(afterToKey);
  const paymentMethods=[PaymentMethod.CASH,PaymentMethod.BANK_TRANSFER,PaymentMethod.UPI,PaymentMethod.CARD];
  const [beforePayments,beforeExpenses,beforeSuppliers,beforeMovements,periodPayments,periodExpenses,periodSuppliers,periodMovements]=await Promise.all([
   prisma.payment.findMany({where:{order:{branchId},method:{in:paymentMethods},createdAt:{lt:start}},select:{amount:true,method:true}}),
   prisma.expense.findMany({where:{branchId,expenseDate:{lt:start}},select:{amount:true,paymentMethod:true}}),
   prisma.supplierPayment.findMany({where:{branchId,paidAt:{lt:start}},select:{amount:true,paymentMethod:true}}),
   prisma.cashMovement.findMany({where:{session:{branchId},createdAt:{lt:start}},select:{amount:true,type:true}}),
   prisma.payment.findMany({where:{order:{branchId},method:{in:paymentMethods},createdAt:{gte:start,lt:end}},include:{order:{select:{number:true,customerName:true}}}}),
   prisma.expense.findMany({where:{branchId,expenseDate:{gte:start,lt:end}},include:{supplier:{select:{name:true}}}}),
   prisma.supplierPayment.findMany({where:{branchId,paidAt:{gte:start,lt:end}},include:{supplier:{select:{name:true}}}}),
   prisma.cashMovement.findMany({where:{session:{branchId},createdAt:{gte:start,lt:end}},select:{id:true,type:true,amount:true,reason:true,createdAt:true}}),
  ]);
  const zero=new Prisma.Decimal(0),sum=(rows:any[])=>rows.reduce((value,row)=>value.add(row.amount),zero),bank=(method:string)=>method!=='CASH';
  const openingCash=sum(beforePayments.filter(row=>row.method==='CASH')).sub(sum(beforeExpenses.filter(row=>row.paymentMethod==='CASH'))).sub(sum(beforeSuppliers.filter(row=>row.paymentMethod==='CASH'))).add(beforeMovements.reduce((value,row)=>row.type==='IN'?value.add(row.amount):value.sub(row.amount),zero));
  const openingBank=sum(beforePayments.filter(row=>bank(row.method))).sub(sum(beforeExpenses.filter(row=>bank(row.paymentMethod)))).sub(sum(beforeSuppliers.filter(row=>bank(row.paymentMethod))));
  const transactions:any[]=[];
  for(const row of periodPayments)transactions.push({id:row.id,date:row.createdAt,account:row.method==='CASH'?'CASH':'BANK',direction:'CREDIT',category:'Sales receipts',description:`Sale · Order #${row.order.number} · ${row.order.customerName}`,amount:row.amount.toFixed(2)});
  for(const row of periodExpenses)transactions.push({id:row.id,date:row.expenseDate,account:row.paymentMethod==='CASH'?'CASH':'BANK',direction:'DEBIT',category:row.category,description:`${row.description}${row.supplier?` · ${row.supplier.name}`:''}${row.notes?` · ${row.notes}`:''}`,amount:row.amount.toFixed(2)});
  for(const row of periodSuppliers)transactions.push({id:row.id,date:row.paidAt,account:row.paymentMethod==='CASH'?'CASH':'BANK',direction:'DEBIT',category:'Supplier payment',description:`Payment to ${row.supplier.name}${row.reference?` · ${row.reference}`:''}${row.notes?` · ${row.notes}`:''}`,amount:row.amount.toFixed(2)});
  for(const row of periodMovements)transactions.push({id:row.id,date:row.createdAt,account:'CASH',direction:row.type==='IN'?'CREDIT':'DEBIT',category:row.type==='IN'?'Cash paid in':'Cash paid out',description:row.reason,amount:row.amount.toFixed(2)});
  transactions.sort((a,b)=>new Date(a.date).getTime()-new Date(b.date).getTime());
  const sumTransactions=(account:string,direction:string)=>transactions.filter(row=>row.account===account&&row.direction===direction).reduce((value,row)=>value.add(new Prisma.Decimal(row.amount)),zero);
  const cashCredits=sumTransactions('CASH','CREDIT'),cashDebits=sumTransactions('CASH','DEBIT'),bankCredits=sumTransactions('BANK','CREDIT'),bankDebits=sumTransactions('BANK','DEBIT');
  response.json({summary:{from,to,openingCash:openingCash.toFixed(2),openingBank:openingBank.toFixed(2),cashCredits:cashCredits.toFixed(2),cashDebits:cashDebits.toFixed(2),bankCredits:bankCredits.toFixed(2),bankDebits:bankDebits.toFixed(2),closingCash:openingCash.add(cashCredits).sub(cashDebits).toFixed(2),closingBank:openingBank.add(bankCredits).sub(bankDebits).toFixed(2),transactions}});
 }catch(error){next(error)}
});
app.post('/api/cash/sessions/open', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = z.object({ branchId: z.string().min(1), openingFloat: moneyText }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide a valid opening cash float.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    if (!canManageCash(request, parsed.data.branchId)) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to open a cash session.' } });
    const session = await prisma.$transaction(async tx => {
      const active = await tx.cashSession.findFirst({ where: { branchId: parsed.data.branchId, openedById: auth.user.id, closedAt: null } });
      if (active) throw new Error('CASH_SESSION_ALREADY_OPEN');
      const created = await tx.cashSession.create({ data: { branchId: parsed.data.branchId, openedById: auth.user.id, openingFloat: new Prisma.Decimal(parsed.data.openingFloat) } });
      await tx.auditLog.create({ data: { branchId: parsed.data.branchId, userId: auth.user.id, action: 'CASH_SESSION_OPENED', details: { sessionId: created.id, openingFloat: created.openingFloat.toFixed(2) } } });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
    response.status(201).json({ session });
  } catch (error) {
    if (error instanceof Error && error.message === 'CASH_SESSION_ALREADY_OPEN') return response.status(409).json({ error: { code: 'CASH_SESSION_ALREADY_OPEN', message: 'You already have an open cash session.' } });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return response.status(409).json({ error: { code: 'CASH_SESSION_CONFLICT', message: 'A concurrent cash session change occurred. Refresh and try again.' } });
    next(error);
  }
});

app.post('/api/cash/sessions/:id/movements', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = z.object({ branchId: z.string().min(1), type: z.enum(['IN','OUT']), amount: moneyText, reason: z.string().trim().min(2).max(300) }).safeParse(request.body);
  if (!parsed.success || (parsed.success && new Prisma.Decimal(parsed.data.amount).lte(0))) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide a positive amount and reason for the cash movement.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    if (!canManageCash(request, parsed.data.branchId)) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to manage cash.' } });
    const membership=branchMembership(request,parsed.data.branchId);
    const session = await prisma.cashSession.findFirst({ where: { id: String(request.params.id), branchId: parsed.data.branchId, closedAt:null,...(!membership||!['OWNER','MANAGER'].includes(membership.role)?{openedById:auth.user.id}:{}) } });
    if (!session) return response.status(404).json({ error: { code: 'CASH_SESSION_NOT_FOUND', message: 'Open cash session was not found.' } });
    const movement = await prisma.$transaction(async tx => {
      const created = await tx.cashMovement.create({ data: { sessionId: session.id, type: parsed.data.type, amount: new Prisma.Decimal(parsed.data.amount), reason: parsed.data.reason } });
      await tx.auditLog.create({ data: { branchId: session.branchId, userId: auth.user.id, action: `CASH_${parsed.data.type}`, details: { movementId: created.id, amount: created.amount.toFixed(2), reason: created.reason } } });
      return created;
    });
    response.status(201).json({ movement });
  } catch (error) { next(error); }
});

app.post('/api/cash/sessions/:id/close', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = z.object({ branchId: z.string().min(1), closingCount: moneyText, varianceReason: z.string().trim().max(300).default('') }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide the counted closing cash amount.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    if (!canManageCash(request, parsed.data.branchId)) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to close a cash session.' } });
    const closed = await prisma.$transaction(async tx => {
      const membership=branchMembership(request,parsed.data.branchId);
      const session = await tx.cashSession.findFirst({ where: { id: String(request.params.id), branchId: parsed.data.branchId, closedAt:null,...(!membership||!['OWNER','MANAGER'].includes(membership.role)?{openedById:auth.user.id}:{}) } });
      if (!session) return null;
      const expected = await cashExpected(tx, session.id, session.openingFloat);
      const counted = new Prisma.Decimal(parsed.data.closingCount);
      const variance = counted.sub(expected);
      if (!variance.isZero() && parsed.data.varianceReason.length < 3) throw new Error('CASH_VARIANCE_REASON_REQUIRED');
      const updated = await tx.cashSession.update({ where: { id: session.id }, data: { closedAt: new Date(), closedById: auth.user.id, closingCount: counted, expectedCash: expected, variance, varianceReason: parsed.data.varianceReason || null } });
      await tx.auditLog.create({ data: { branchId: session.branchId, userId: auth.user.id, action: 'CASH_SESSION_CLOSED', details: { sessionId: session.id, expected: expected.toFixed(2), counted: counted.toFixed(2), variance: variance.toFixed(2), varianceReason: parsed.data.varianceReason } } });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
    if (!closed) return response.status(404).json({ error: { code: 'CASH_SESSION_NOT_FOUND', message: 'Open cash session was not found.' } });
    response.json({ session: closed });
  } catch (error) {
    if (error instanceof Error && error.message === 'CASH_VARIANCE_REASON_REQUIRED') return response.status(400).json({ error: { code: 'CASH_VARIANCE_REASON_REQUIRED', message: 'Explain any difference between expected and counted cash.' } });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return response.status(409).json({ error: { code: 'CASH_SESSION_CONFLICT', message: 'Cash activity changed while closing. Refresh and try again.' } });
    next(error);
  }
});

app.post('/api/orders/:number/payments', requireSameOrigin, requireSession, async (request, response, next) => {
  const parsed = cashPaymentInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide a valid cash payment amount and amount received.' } });
  const key = request.header('Idempotency-Key');
  if (!key || key.length < 12 || key.length > 200) return response.status(400).json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send a unique Idempotency-Key header.' } });
  const amount = new Prisma.Decimal(parsed.data.amount);
  const cashReceived = new Prisma.Decimal(parsed.data.cashReceived ?? parsed.data.amount);
  if (amount.lte(0) || (parsed.data.method === 'CASH' && cashReceived.lt(amount))) return response.status(400).json({ error: { code: 'INVALID_CASH_AMOUNT', message: 'Cash received must cover the payment amount.' } });
  try {
    const auth = (request as AuthRequest).auth!;
    const orderNumber = Number(request.params.number);
    if (!Number.isSafeInteger(orderNumber) || orderNumber < 1) return response.status(400).json({ error: { code: 'INVALID_ORDER', message: 'Order number is invalid.' } });
    const order = await prisma.order.findFirst({ where: { number: orderNumber, branchId: parsed.data.branchId }, include: { items: true, deliveryAssignment: true } });
    if (!order) return response.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: 'Order was not found.' } });
    const membership = branchMembership(request, order.branchId);
    if (!membership) return response.status(403).json({ error: { code: 'BRANCH_FORBIDDEN', message: 'You do not have access to this branch.' } });
    const driverCollectingDeliveryCash = membership.role === StaffRole.DELIVERY && order.type === OrderType.DELIVERY && order.deliveryAssignment?.staffId === auth.user.id;
    if (!rolePermissions[membership.role].includes('payments.create') && !driverCollectingDeliveryCash) return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to record payments.' } });
    if(order.tableSessionId)return response.status(409).json({error:{code:'TABLE_SESSION_USE_SETTLE',message:'This order belongs to a table bill. Settle all rounds together from the Tables page.'}});
    const existing = await prisma.payment.findUnique({ where: { idempotencyKey: key } });
    if (existing) return response.status(200).json({ payment: existing, replayed: true });
    const result = await prisma.$transaction(async tx => {
      const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      if (current.paymentStatus === 'PAID' || current.paymentStatus === 'REFUNDED') throw new Error('ORDER_ALREADY_SETTLED');
      const paid = await tx.payment.aggregate({ where: { orderId: current.id }, _sum: { amount: true } });
      const balance = current.total.sub(paid._sum.amount ?? new Prisma.Decimal(0));
      if (amount.gt(balance)) throw new Error('PAYMENT_EXCEEDS_BALANCE');
      const cashSession = parsed.data.method === 'CASH' ? await tx.cashSession.findFirst({ where: { branchId: current.branchId, openedById: auth.user.id, closedAt: null } }) : null;
      if (parsed.data.method === 'CASH' && !cashSession && !driverCollectingDeliveryCash) throw new Error('CASH_SESSION_REQUIRED');
      if (driverCollectingDeliveryCash) {
        const assignment = await tx.deliveryAssignment.findFirst({ where: { orderId: current.id, staffId: auth.user.id } });
        if (!assignment) throw new Error('DELIVERY_NOT_ASSIGNED');
      }
      const payment = await tx.payment.create({ data: {
        orderId: current.id, method: parsed.data.method, amount, cashReceived: parsed.data.method === 'CASH' ? cashReceived : null,
        changeGiven: parsed.data.method === 'CASH' ? cashReceived.sub(amount) : null, idempotencyKey: key, verified: true, recordedById: auth.user.id, cashSessionId: cashSession?.id,
      } });
      const nextPaid = (paid._sum.amount ?? new Prisma.Decimal(0)).add(amount);
      const settled = nextPaid.gte(current.total);
      await tx.order.update({ where: { id: current.id }, data: { paymentStatus: settled ? 'PAID' : 'PARTIAL' } });
      let bill = null;
      if (settled) {
        bill = await tx.bill.upsert({ where: { orderId: current.id }, update: {}, create: { branchId: current.branchId, orderId: current.id } });
      }
      await tx.auditLog.create({ data: { branchId: current.branchId, userId: auth.user.id, orderId: current.id, action: `${parsed.data.method}_PAYMENT_RECORDED`, details: { paymentId: payment.id, amount: amount.toFixed(2), method: parsed.data.method, cashReceived: payment.cashReceived?.toFixed(2), changeGiven: payment.changeGiven?.toFixed(2) } } });
      return { payment, bill, balanceRemaining: settled ? '0.00' : current.total.sub(nextPaid).toFixed(2) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
    response.status(201).json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'ORDER_ALREADY_SETTLED') return response.status(409).json({ error: { code: 'ORDER_ALREADY_SETTLED', message: 'This order is already fully paid.' } });
    if (error instanceof Error && error.message === 'PAYMENT_EXCEEDS_BALANCE') return response.status(409).json({ error: { code: 'PAYMENT_EXCEEDS_BALANCE', message: 'Payment amount exceeds the outstanding balance.' } });
    if (error instanceof Error && error.message === 'CASH_SESSION_REQUIRED') return response.status(409).json({ error: { code: 'CASH_SESSION_REQUIRED', message: 'Open your cash session before receiving a cash payment.' } });
    if (error instanceof Error && error.message === 'DELIVERY_NOT_ASSIGNED') return response.status(403).json({ error: { code: 'DELIVERY_NOT_ASSIGNED', message: 'This delivery is no longer assigned to you.' } });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const payment = await prisma.payment.findUnique({ where: { idempotencyKey: key } });
      if (payment) return response.status(200).json({ payment, replayed: true });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return response.status(409).json({ error: { code: 'PAYMENT_CONFLICT', message: 'Another payment changed this order. Refresh and try again.' } });
    next(error);
  }
});

const tableSessionPaymentInput=z.object({branchId:z.string().min(1),method:z.enum(['CASH','BANK_TRANSFER']).default('CASH'),cashReceived:moneyText.optional()});
app.post('/api/table-sessions/:id/settle',requireSameOrigin,requireSession,async(request,response,next)=>{
  const parsed=tableSessionPaymentInput.safeParse(request.body);if(!parsed.success)return response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Enter a valid payment amount.'}});
 const key=request.header('Idempotency-Key');if(!key||key.length<12||key.length>200)return response.status(400).json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'Send a unique Idempotency-Key header.'}});
 try{
  const auth=(request as AuthRequest).auth!;const branchId=parsed.data.branchId;const membership=branchMembership(request,branchId);
  if(!membership||!rolePermissions[membership.role].includes('payments.create'))return response.status(403).json({error:{code:'PERMISSION_DENIED',message:'You do not have permission to record payments.'}});
  const replay=await prisma.auditLog.findFirst({where:{branchId,action:'TABLE_SESSION_SETTLED',details:{path:['idempotencyKey'],equals:key}},select:{details:true}});if(replay)return response.status(200).json({settlement:replay.details,replayed:true});
  const session=await prisma.tableSession.findFirst({where:{id:String(request.params.id),branchId,status:'OPEN'},include:{table:true,orders:{where:{status:{not:OrderStatus.CANCELLED}},include:{payments:true},orderBy:{createdAt:'asc'}}}});
  if(!session)return response.status(404).json({error:{code:'TABLE_SESSION_NOT_FOUND',message:'Open table session was not found.'}});
  const balances=session.orders.map(order=>({order,balance:order.total.sub(order.payments.reduce((sum,payment)=>sum.add(payment.amount),new Prisma.Decimal(0)))})).filter(entry=>entry.balance.gt(0));
   const due=balances.reduce((sum,entry)=>sum.add(entry.balance),new Prisma.Decimal(0));const received=new Prisma.Decimal(parsed.data.cashReceived??due.toFixed(2));
  if(due.lte(0))return response.status(409).json({error:{code:'TABLE_SESSION_ALREADY_PAID',message:'This table session has no amount due.'}});
   if(parsed.data.method==='CASH'&&received.lt(due))return response.status(400).json({error:{code:'CASH_BELOW_DUE',message:`Cash received must be at least ${due.toFixed(2)}.`}});
  const result=await prisma.$transaction(async tx=>{
   const current=await tx.tableSession.findFirst({where:{id:session.id,status:'OPEN'},include:{orders:{where:{status:{not:OrderStatus.CANCELLED}},include:{payments:true},orderBy:{createdAt:'asc'}}}});if(!current)throw new Error('TABLE_SESSION_ALREADY_CLOSED');
   const currentBalances=current.orders.map(order=>({order,balance:order.total.sub(order.payments.reduce((sum,payment)=>sum.add(payment.amount),new Prisma.Decimal(0)))})).filter(entry=>entry.balance.gt(0));const currentDue=currentBalances.reduce((sum,entry)=>sum.add(entry.balance),new Prisma.Decimal(0));
   if(!currentDue.eq(due))throw new Error('TABLE_SESSION_CHANGED');
    const cashSession=parsed.data.method==='CASH'?await tx.cashSession.findFirst({where:{branchId,openedById:auth.user.id,closedAt:null}}):null;if(parsed.data.method==='CASH'&&!cashSession)throw new Error('CASH_SESSION_REQUIRED');
    const change=parsed.data.method==='CASH'?received.sub(currentDue):new Prisma.Decimal(0);const paymentIds:string[]=[];
   for(let i=0;i<currentBalances.length;i++){
    const {order,balance}=currentBalances[i];const last=i===currentBalances.length-1;
     const payment=await tx.payment.create({data:{orderId:order.id,method:parsed.data.method,amount:balance,cashReceived:parsed.data.method==='CASH'&&last?received:null,changeGiven:parsed.data.method==='CASH'&&last?change:null,idempotencyKey:`${key}:${order.id}`,verified:true,recordedById:auth.user.id,cashSessionId:cashSession?.id}});paymentIds.push(payment.id);
    await tx.order.update({where:{id:order.id},data:{paymentStatus:PaymentStatus.PAID}});
   }
   const closed=await tx.tableSession.updateMany({where:{id:current.id,status:'OPEN'},data:{status:'CLOSED',closedAt:new Date()}});if(!closed.count)throw new Error('TABLE_SESSION_ALREADY_CLOSED');
   const bill=await tx.tableSessionBill.create({data:{sessionId:current.id}});
   await tx.diningTable.updateMany({where:{id:current.tableId,status:'OCCUPIED'},data:{status:'AVAILABLE'}});
    await tx.auditLog.create({data:{branchId,userId:auth.user.id,action:'TABLE_SESSION_SETTLED',details:{sessionId:current.id,billNumber:bill.number,idempotencyKey:key,due:currentDue.toFixed(2),method:parsed.data.method,cashReceived:parsed.data.method==='CASH'?received.toFixed(2):null,change:change.toFixed(2),paymentIds}}});
    return {sessionId:current.id,billNumber:bill.number,due:currentDue.toFixed(2),method:parsed.data.method,cashReceived:parsed.data.method==='CASH'?received.toFixed(2):null,change:change.toFixed(2),paymentIds};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:10000,timeout:30000});
  publishBranchEvent(branchId, 'tables.changed', { sessionId: result.sessionId });
  publishBranchEvent(branchId, 'orders.changed', { sessionId: result.sessionId });
  response.status(201).json({settlement:result});
 }catch(error){
  if(error instanceof Error&&error.message==='CASH_SESSION_REQUIRED')return response.status(409).json({error:{code:'CASH_SESSION_REQUIRED',message:'Open your cash register before receiving a cash payment.'}});
  if(error instanceof Error&&error.message==='TABLE_SESSION_ALREADY_CLOSED')return response.status(409).json({error:{code:'TABLE_SESSION_ALREADY_CLOSED',message:'This table session has already been settled.'}});
  if(error instanceof Error&&error.message==='TABLE_SESSION_CHANGED')return response.status(409).json({error:{code:'TABLE_SESSION_CHANGED',message:'New orders or payments changed this table bill. Refresh and try again.'}});
  if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){const replay=await prisma.auditLog.findFirst({where:{branchId:parsed.data.branchId,action:'TABLE_SESSION_SETTLED',details:{path:['idempotencyKey'],equals:key}}});if(replay)return response.status(200).json({settlement:replay.details,replayed:true})}
  if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2034')return response.status(409).json({error:{code:'TABLE_SESSION_CHANGED',message:'The table bill changed while settling. Refresh and retry.'}});
  next(error);
 }
});

app.get('/api/bills/table-session/:id',requireSession,async(request,response,next)=>{
 try{
  const auth=(request as AuthRequest).auth!;const branchId=String(request.query.branchId??process.env.DEMO_BRANCH_ID??'demo-indiranagar');const membership=branchMembership(request,branchId);
  if(!membership||!rolePermissions[membership.role].includes('orders.read'))return response.status(403).json({error:{code:'BRANCH_FORBIDDEN',message:'You do not have access to this bill.'}});
  const bill=await prisma.tableSessionBill.findFirst({where:{sessionId:String(request.params.id),session:{branchId}},include:{session:{include:{table:true,branch:{include:{restaurant:true}},orders:{where:{status:{not:OrderStatus.CANCELLED}},include:{items:true,payments:{orderBy:{createdAt:'asc'}}},orderBy:{createdAt:'asc'}}}}}});
  if(!bill)return response.status(404).json({error:{code:'BILL_NOT_FOUND',message:'Combined bill was not found.'}});
  if(request.query.print==='1')await prisma.$transaction([prisma.tableSessionBill.update({where:{id:bill.id},data:{printCount:{increment:1},lastPrintedAt:new Date()}}),prisma.auditLog.create({data:{branchId,userId:auth.user.id,action:bill.printCount?'TABLE_SESSION_BILL_REPRINTED':'TABLE_SESSION_BILL_PRINTED',details:{sessionId:bill.sessionId,billNumber:bill.number}}})]);
  response.json({bill});
 }catch(error){next(error)}
});

app.get('/api/bills/order/:number', requireSession, async (request, response, next) => {
  try {
    const auth = (request as AuthRequest).auth!;
    const number = Number(request.params.number);
    const branchId = String(request.query.branchId ?? process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar');
    const membership = branchMembership(request, branchId);
    if (!membership || !rolePermissions[membership.role].includes('orders.read')) return response.status(403).json({ error: { code: 'BRANCH_FORBIDDEN', message: 'You do not have access to this bill.' } });
    const bill = await prisma.bill.findFirst({ where: { order: { number, branchId } }, include: { branch: { include: { restaurant: true } }, order: { include: { items: true, payments: { orderBy: { createdAt: 'asc' } }, table: true } } } });
    if (!bill) return response.status(404).json({ error: { code: 'BILL_NOT_FOUND', message: 'A bill is available after the order is fully paid.' } });
    if (request.query.print === '1') {
      await prisma.$transaction([
        prisma.bill.update({ where: { id: bill.id }, data: { printCount: { increment: 1 }, lastPrintedAt: new Date() } }),
        prisma.auditLog.create({ data: { branchId: bill.branchId, userId: auth.user.id, orderId: bill.orderId, action: bill.printCount ? 'BILL_REPRINTED' : 'BILL_PRINTED', details: { billNumber: bill.number, previousPrintCount: bill.printCount } } }),
      ]);
    }
    response.json({ bill });
  } catch (error) { next(error); }
});

app.use((_request, response) => {
  response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error('API request failed', error instanceof Error ? error.message : 'unknown error');
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
});

if (process.env.VERCEL !== '1' && process.env.NODE_ENV !== 'test') {
  app.listen(port, '127.0.0.1', () => {
    console.log(`Restaurant API listening on http://localhost:${port}`);
  });
}

export { app, prisma };

process.on('SIGINT', async () => { await prisma.$disconnect(); process.exit(0); });
