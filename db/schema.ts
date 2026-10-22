import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";

// Каждый приглашённый игрок засчитывается ровно один раз (первичный ключ — его VK ID)
export const referrals = pgTable(
  "referrals",
  {
    inviteeId: text("invitee_id").primaryKey(),
    referrerId: text("referrer_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("referrals_referrer_idx").on(t.referrerId)],
);

// Сколько друзей пригласивший уже обменял на награды (защита от повторного получения)
export const referralClaims = pgTable("referral_claims", {
  vkId: text("vk_id").primaryKey(),
  claimed: integer("claimed").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
