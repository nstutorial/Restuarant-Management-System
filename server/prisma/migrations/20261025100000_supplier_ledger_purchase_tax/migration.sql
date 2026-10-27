ALTER TABLE "Supplier" ADD COLUMN "openingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0;

CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paymentMethod" TEXT NOT NULL DEFAULT 'BANK',
    "reference" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupplierPayment_branchId_supplierId_paidAt_idx" ON "SupplierPayment"("branchId", "supplierId", "paidAt");
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
