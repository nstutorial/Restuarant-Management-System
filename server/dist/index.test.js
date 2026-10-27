import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { PrismaClient, StaffRole } from '@prisma/client';
import { app, prisma } from './index.js';
const testPrisma = new PrismaClient();
const origin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
test('cash POS order can be paid, printed, retried safely and reconciled', async () => {
    const branchId = process.env.DEMO_BRANCH_ID ?? 'demo-indiranagar';
    const branch = await testPrisma.branch.findUniqueOrThrow({ where: { id: branchId } });
    const menuItem = await testPrisma.menuItem.findFirstOrThrow({ where: { branchId, available: true, deletedAt: null } });
    const suffix = randomBytes(8).toString('hex');
    const user = await testPrisma.user.create({ data: { name: 'Integration Cashier', email: `cash-test-${suffix}@example.test`, passwordHash: 'integration-test-only' } });
    const manager = await testPrisma.user.create({ data: { name: 'Integration Manager', email: `manager-test-${suffix}@example.test`, passwordHash: 'integration-test-only' } });
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const session = await testPrisma.session.create({ data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 60 * 60_000) } });
    await testPrisma.branchMembership.create({ data: { userId: user.id, branchId, role: StaffRole.CASHIER } });
    await testPrisma.branchMembership.create({ data: { userId: manager.id, branchId, role: StaffRole.MANAGER } });
    const managerToken = randomBytes(32).toString('base64url');
    await testPrisma.session.create({ data: { userId: manager.id, tokenHash: createHash('sha256').update(managerToken).digest('hex'), expiresAt: new Date(Date.now() + 60 * 60_000) } });
    const server = createServer(app);
    let orderDbId;
    let deliveryOrderDbId;
    let deliveryOrderKey;
    let customerDbId;
    let cashSessionId;
    let tableId;
    let originalTableStatus;
    let inventoryItemId;
    let supplierId;
    let purchaseOrderId;
    let expenseId;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert(address && typeof address !== 'string');
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const request = (path, body, method = 'GET', idempotencyKey) => fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                Origin: origin,
                Cookie: `restaurant_session=${encodeURIComponent(rawToken)}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const managerRequest = (path, body, method = 'GET') => fetch(`${baseUrl}${path}`, {
            method,
            headers: { Origin: origin, Cookie: `restaurant_session=${encodeURIComponent(managerToken)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const inventoryResponse = await managerRequest('/api/inventory', { branchId, name: `Test ingredient ${suffix}`, category: 'Test', unit: 'kg', quantity: '0', reorderLevel: '1', unitCost: '2.50' }, 'POST');
        assert.equal(inventoryResponse.status, 201);
        inventoryItemId = (await inventoryResponse.json()).item.id;
        const supplierResponse = await managerRequest('/api/suppliers', { branchId, name: `Test supplier ${suffix}`, contactName: '', phone: '', email: '', address: '' }, 'POST');
        assert.equal(supplierResponse.status, 201);
        supplierId = (await supplierResponse.json()).supplier.id;
        const purchaseResponse = await managerRequest('/api/purchases', { branchId, supplierId, items: [{ inventoryItemId, quantity: '5.5', unitCost: '3.25' }] }, 'POST');
        assert.equal(purchaseResponse.status, 201);
        purchaseOrderId = (await purchaseResponse.json()).order.id;
        const purchase = await testPrisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId }, include: { items: true } });
        const receiveResponse = await managerRequest(`/api/purchases/${purchaseOrderId}/receive`, { branchId, items: [{ itemId: purchase.items[0].id, quantity: '5.5' }] }, 'POST');
        assert.equal(receiveResponse.status, 200);
        assert.equal(Number((await testPrisma.inventoryItem.findUniqueOrThrow({ where: { id: inventoryItemId } })).quantity), 5.5);
        const expenseResponse = await managerRequest('/api/expenses', { branchId, category: 'Test', description: 'Integration test expense', amount: '10.00', notes: '' }, 'POST');
        assert.equal(expenseResponse.status, 201);
        expenseId = (await expenseResponse.json()).expense.id;
        assert.equal((await managerRequest(`/api/settings/branch?branchId=${branchId}`)).status, 200);
        assert.equal((await managerRequest(`/api/staff?branchId=${branchId}`)).status, 200);
        assert.equal((await managerRequest(`/api/reports/dashboard?branchId=${branchId}`)).status, 200);
        deliveryOrderKey = `test-delivery-${suffix}-unique`;
        const deliveryResponse = await request('/api/orders', { branchId, type: 'DELIVERY', customerName: 'Test Delivery Guest', deliveryPhone: '5550100', deliveryAddress: 'Test address', discount: '0.00', items: [{ menuItemId: menuItem.id, quantity: 1 }] }, 'POST', deliveryOrderKey);
        assert.equal(deliveryResponse.status, 201);
        deliveryOrderDbId = (await deliveryResponse.json()).order.id;
        const deliveriesResponse = await managerRequest(`/api/deliveries?branchId=${branchId}`);
        assert.equal(deliveriesResponse.status, 200);
        const tableResponse = await request(`/api/tables?branchId=${branchId}`);
        assert.equal(tableResponse.status, 200);
        const tableResult = await tableResponse.json();
        const availableTable = tableResult.tables.find(table => table.status === 'AVAILABLE');
        assert.ok(availableTable, 'seeded branch should have an available table');
        tableId = availableTable.id;
        originalTableStatus = availableTable.status;
        const occupiedResponse = await request(`/api/tables/${tableId}/status`, { branchId, status: 'OCCUPIED' }, 'PATCH');
        assert.equal(occupiedResponse.status, 200);
        assert.equal((await occupiedResponse.json()).table.status, 'OCCUPIED');
        const releasedResponse = await request(`/api/tables/${tableId}/status`, { branchId, status: 'AVAILABLE' }, 'PATCH');
        assert.equal(releasedResponse.status, 200);
        const customerResponse = await request('/api/customers', { branchId, name: `Test Guest ${suffix}`, phone: `+1555${suffix}`, email: '', notes: '' }, 'POST');
        assert.equal(customerResponse.status, 201);
        const customerResult = await customerResponse.json();
        customerDbId = customerResult.customer.id;
        const openResponse = await request('/api/cash/sessions/open', { branchId, openingFloat: '500.00' }, 'POST');
        assert.equal(openResponse.status, 201);
        const opened = await openResponse.json();
        cashSessionId = opened.session.id;
        const orderKey = `test-order-${suffix}-unique`;
        const orderBody = { branchId, type: 'TAKEAWAY', customerId: customerDbId, customerName: 'Test Guest', discount: '0.00', items: [{ menuItemId: menuItem.id, quantity: 1 }] };
        const orderResponse = await request('/api/orders', orderBody, 'POST', orderKey);
        assert.equal(orderResponse.status, 201);
        const orderResult = await orderResponse.json();
        orderDbId = orderResult.order.id;
        const replayResponse = await request('/api/orders', orderBody, 'POST', orderKey);
        assert.equal(replayResponse.status, 200);
        assert.equal((await replayResponse.json()).replayed, true);
        const amount = Number(orderResult.order.total);
        const paymentKey = `test-payment-${suffix}-unique`;
        const paymentBody = { branchId, method: 'CASH', amount: amount.toFixed(2), cashReceived: (amount + 50).toFixed(2) };
        const paymentResponse = await request(`/api/orders/${orderResult.order.number}/payments`, paymentBody, 'POST', paymentKey);
        assert.equal(paymentResponse.status, 201);
        const paymentResult = await paymentResponse.json();
        assert.equal(Number(paymentResult.payment.amount), amount);
        assert.equal(Number(paymentResult.payment.cashReceived), amount + 50);
        assert.equal(Number(paymentResult.payment.changeGiven), 50);
        assert.ok(paymentResult.bill.id);
        const paymentReplay = await request(`/api/orders/${orderResult.order.number}/payments`, paymentBody, 'POST', paymentKey);
        assert.equal(paymentReplay.status, 200);
        assert.equal((await paymentReplay.json()).replayed, true);
        const duplicatePayment = await request(`/api/orders/${orderResult.order.number}/payments`, paymentBody, 'POST', `test-repay-${suffix}-unique`);
        assert.equal(duplicatePayment.status, 409);
        const printResponse = await request(`/api/bills/order/${orderResult.order.number}?branchId=${branchId}&print=1`);
        assert.equal(printResponse.status, 200);
        const printedBill = await printResponse.json();
        assert.ok(printedBill.bill.number > 0);
        const drawerResponse = await request(`/api/cash/session?branchId=${branchId}`);
        assert.equal(drawerResponse.status, 200);
        const drawer = await drawerResponse.json();
        assert.equal(Number(drawer.session.expectedCash), 500 + amount);
        const closeResponse = await request(`/api/cash/sessions/${cashSessionId}/close`, { branchId, closingCount: (500 + amount).toFixed(2), varianceReason: '' }, 'POST');
        assert.equal(closeResponse.status, 200);
    }
    finally {
        await new Promise(resolve => server.close(() => resolve()));
        if (tableId && originalTableStatus)
            await testPrisma.diningTable.update({ where: { id: tableId }, data: { status: originalTableStatus } });
        if (orderDbId) {
            await testPrisma.auditLog.deleteMany({ where: { OR: [{ orderId: orderDbId }, { userId: user.id }] } });
            await testPrisma.bill.deleteMany({ where: { orderId: orderDbId } });
            await testPrisma.payment.deleteMany({ where: { orderId: orderDbId } });
            await testPrisma.orderItem.deleteMany({ where: { orderId: orderDbId } });
            await testPrisma.order.delete({ where: { id: orderDbId } });
        }
        else {
            await testPrisma.auditLog.deleteMany({ where: { userId: user.id } });
        }
        if (!deliveryOrderDbId && deliveryOrderKey)
            deliveryOrderDbId = (await testPrisma.order.findUnique({ where: { idempotencyKey: deliveryOrderKey }, select: { id: true } }))?.id;
        if (deliveryOrderDbId) {
            await testPrisma.deliveryStatusHistory.deleteMany({ where: { assignment: { orderId: deliveryOrderDbId } } });
            await testPrisma.deliveryAssignment.deleteMany({ where: { orderId: deliveryOrderDbId } });
            await testPrisma.auditLog.deleteMany({ where: { orderId: deliveryOrderDbId } });
            await testPrisma.orderItem.deleteMany({ where: { orderId: deliveryOrderDbId } });
            await testPrisma.order.deleteMany({ where: { id: deliveryOrderDbId } });
        }
        if (customerDbId)
            await testPrisma.customer.deleteMany({ where: { id: customerDbId } });
        await testPrisma.auditLog.deleteMany({ where: { userId: manager.id } });
        if (expenseId)
            await testPrisma.expense.deleteMany({ where: { id: expenseId } });
        if (purchaseOrderId)
            await testPrisma.purchaseOrder.deleteMany({ where: { id: purchaseOrderId } });
        if (inventoryItemId) {
            await testPrisma.stockMovement.deleteMany({ where: { inventoryItemId } });
            await testPrisma.inventoryItem.deleteMany({ where: { id: inventoryItemId } });
        }
        if (supplierId)
            await testPrisma.supplier.deleteMany({ where: { id: supplierId } });
        if (cashSessionId) {
            await testPrisma.cashMovement.deleteMany({ where: { sessionId: cashSessionId } });
            await testPrisma.cashSession.deleteMany({ where: { id: cashSessionId } });
        }
        await testPrisma.session.deleteMany({ where: { userId: user.id } });
        await testPrisma.branchMembership.deleteMany({ where: { userId: user.id } });
        await testPrisma.user.delete({ where: { id: user.id } });
        await testPrisma.session.deleteMany({ where: { userId: manager.id } });
        await testPrisma.branchMembership.deleteMany({ where: { userId: manager.id } });
        await testPrisma.user.delete({ where: { id: manager.id } });
        await Promise.all([prisma.$disconnect(), testPrisma.$disconnect()]);
    }
});
