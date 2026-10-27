ALTER TABLE "OrderItem"
ADD COLUMN "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 5;

UPDATE "OrderItem" AS item
SET "taxRate" = branch."taxRate"
FROM "Order" AS order_record
JOIN "Branch" AS branch ON branch."id" = order_record."branchId"
WHERE item."orderId" = order_record."id";
