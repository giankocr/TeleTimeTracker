-- CreateTable
CREATE TABLE "bot_contacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "username" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "userId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "roleId" TEXT NOT NULL,
    "managerId" TEXT,
    "telegramId" TEXT,
    "telegramUsername" TEXT,
    "telegramLinkedAt" DATETIME,
    "telegramLinkCode" TEXT,
    "telegramLinkExp" DATETIME,
    "phone" TEXT,
    "phoneVerifiedAt" DATETIME,
    "otpCodeHash" TEXT,
    "otpExpiresAt" DATETIME,
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "otpLastSentAt" DATETIME,
    "githubUsername" TEXT,
    "githubToken" TEXT,
    "workDays" TEXT NOT NULL DEFAULT '1,2,3,4,5',
    "workStart" TEXT NOT NULL DEFAULT '09:00',
    "workEnd" TEXT NOT NULL DEFAULT '18:00',
    "timezone" TEXT NOT NULL DEFAULT 'America/Bogota',
    "idleAlertMin" INTEGER NOT NULL DEFAULT 45,
    "dailyDigest" BOOLEAN NOT NULL DEFAULT true,
    "locale" TEXT NOT NULL DEFAULT 'es',
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "users_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_users" ("createdAt", "dailyDigest", "email", "fullName", "githubToken", "githubUsername", "id", "idleAlertMin", "isActive", "lastLoginAt", "locale", "managerId", "passwordHash", "roleId", "telegramId", "telegramLinkCode", "telegramLinkExp", "telegramLinkedAt", "telegramUsername", "timezone", "updatedAt", "workDays", "workEnd", "workStart") SELECT "createdAt", "dailyDigest", "email", "fullName", "githubToken", "githubUsername", "id", "idleAlertMin", "isActive", "lastLoginAt", "locale", "managerId", "passwordHash", "roleId", "telegramId", "telegramLinkCode", "telegramLinkExp", "telegramLinkedAt", "telegramUsername", "timezone", "updatedAt", "workDays", "workEnd", "workStart" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");
CREATE UNIQUE INDEX "users_telegramLinkCode_key" ON "users"("telegramLinkCode");
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");
CREATE INDEX "users_roleId_idx" ON "users"("roleId");
CREATE INDEX "users_managerId_idx" ON "users"("managerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "bot_contacts_telegramId_key" ON "bot_contacts"("telegramId");

-- CreateIndex
CREATE INDEX "bot_contacts_status_idx" ON "bot_contacts"("status");
