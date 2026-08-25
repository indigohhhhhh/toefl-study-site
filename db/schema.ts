import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const userStates = sqliteTable("user_states", {
  userId: text("user_id").primaryKey(),
  stateJson: text("state_json").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    module: text("module").notNull(),
    itemId: text("item_id").notNull(),
    answer: text("answer").notNull(),
    expected: text("expected").notNull(),
    correct: integer("correct", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("attempt_session_item_idx").on(table.sessionId, table.itemId, table.module),
  ],
);

export const recycleBin = sqliteTable("recycle_bin", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  payloadJson: text("payload_json").notNull(),
  deletedAt: text("deleted_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const siteAuth = sqliteTable("site_auth", {
  id: text("id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  passwordIterations: integer("password_iterations").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const authLoginAttempts = sqliteTable("auth_login_attempts", {
  fingerprint: text("fingerprint").primaryKey(),
  failedCount: integer("failed_count").notNull().default(0),
  firstFailedAt: text("first_failed_at").notNull(),
  blockedUntil: text("blocked_until"),
  updatedAt: text("updated_at").notNull(),
});
