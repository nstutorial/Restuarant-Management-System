CREATE TABLE "InventoryUnit" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryUnit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryUnit_branchId_name_key" ON "InventoryUnit"("branchId", "name");
CREATE INDEX "InventoryUnit_branchId_idx" ON "InventoryUnit"("branchId");
ALTER TABLE "InventoryUnit" ADD CONSTRAINT "InventoryUnit_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "unit" TEXT NOT NULL DEFAULT 'pcs';
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "unitFactor" DECIMAL(14,6) NOT NULL DEFAULT 1;
