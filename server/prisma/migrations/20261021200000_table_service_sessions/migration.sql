CREATE TABLE "TableSession" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "customerName" TEXT NOT NULL DEFAULT 'Walk-in Guest',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "TableSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TableSessionBill" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printCount" INTEGER NOT NULL DEFAULT 0,
    "lastPrintedAt" TIMESTAMP(3),
    CONSTRAINT "TableSessionBill_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Order" ADD COLUMN "tableSessionId" TEXT;

CREATE UNIQUE INDEX "TableSessionBill_sessionId_key" ON "TableSessionBill"("sessionId");
CREATE UNIQUE INDEX "TableSessionBill_number_key" ON "TableSessionBill"("number");
CREATE INDEX "TableSession_branchId_status_startedAt_idx" ON "TableSession"("branchId", "status", "startedAt");
CREATE INDEX "TableSession_tableId_status_idx" ON "TableSession"("tableId", "status");

ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TableSessionBill" ADD CONSTRAINT "TableSessionBill_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TableSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_tableSessionId_fkey" FOREIGN KEY ("tableSessionId") REFERENCES "TableSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
