CREATE TABLE "CustomerPortalAccount" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerPortalAccount_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CustomerPortalSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "CustomerPortalSession_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Order" ADD COLUMN "deliveryDistanceKm" DECIMAL(7,2);
CREATE UNIQUE INDEX "CustomerPortalAccount_customerId_key" ON "CustomerPortalAccount"("customerId");
CREATE UNIQUE INDEX "CustomerPortalAccount_email_key" ON "CustomerPortalAccount"("email");
CREATE INDEX "CustomerPortalAccount_active_createdAt_idx" ON "CustomerPortalAccount"("active", "createdAt");
CREATE UNIQUE INDEX "CustomerPortalSession_tokenHash_key" ON "CustomerPortalSession"("tokenHash");
CREATE INDEX "CustomerPortalSession_accountId_expiresAt_idx" ON "CustomerPortalSession"("accountId", "expiresAt");
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");
ALTER TABLE "CustomerPortalAccount" ADD CONSTRAINT "CustomerPortalAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerPortalSession" ADD CONSTRAINT "CustomerPortalSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerPortalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;