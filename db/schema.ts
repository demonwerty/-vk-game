// db/schema.ts
import {
  pgTable,
  bigint,
  timestamp,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

/**
 * Таблица referrals — кто кого пригласил.
 * inviteeId — PK, чтобы один игрок не мог быть засчитан дважды.
 */
export const referrals = pgTable(
  "referrals",
  {
    inviteeId: bigint("invitee_id", { mode: "number" }).primaryKey(),
    referrerId: bigint("referrer_id", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    referrerIdx: index("referrals_referrer_idx").on(t.referrerId),
  })
);

/**
 * Таблица referralClaims — сколько наград уже получено каждым реферером.
 * vkId — PK, одна строка на пользователя.
 */
export const referralClaims = pgTable("referral_claims", {
  vkId: bigint("vk_id", { mode: "number" }).primaryKey(),
  claimed: integer("claimed").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Referral = typeof referrals.$inferSelect;
export type ReferralClaim = typeof referralClaims.$inferSelect;
