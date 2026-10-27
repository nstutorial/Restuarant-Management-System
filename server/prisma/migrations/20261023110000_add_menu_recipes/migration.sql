CREATE TABLE "MenuRecipeLine" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MenuRecipeLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MenuRecipeLine_menuItemId_inventoryItemId_key" ON "MenuRecipeLine"("menuItemId", "inventoryItemId");
CREATE INDEX "MenuRecipeLine_inventoryItemId_idx" ON "MenuRecipeLine"("inventoryItemId");

ALTER TABLE "MenuRecipeLine" ADD CONSTRAINT "MenuRecipeLine_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuRecipeLine" ADD CONSTRAINT "MenuRecipeLine_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
