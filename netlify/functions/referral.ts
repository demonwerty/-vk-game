import type { Config } from "@netlify/functions";
import { createHmac, timingSafeEqual } from "node:crypto";
import { count, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { referralClaims, referrals } from "../../db/schema.js";

// VK ID — только цифры; всё остальное (гостевые сессии, мусор) не засчитывается
const VK_ID = /^\d{1,12}$/;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Проверка подписи параметров запуска VK Mini App.
// Если секрет приложения задан в переменных окружения, ID игрока берётся
// только из подписанных параметров — подделать чужой ID нельзя.
function verifiedVkId(launch: string | undefined): string | null | undefined {
  const secret = process.env.VK_APP_SECRET;
  if (!secret) return undefined; // проверка выключена
  if (!launch) return null;
  const params = new URLSearchParams(launch.replace(/^\?/, ""));
  const sign = params.get("sign");
  if (!sign) return null;
  const signed = [...params.entries()]
    .filter(([k]) => k.startsWith("vk_"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(signed).toString();
  const expected = createHmac("sha256", secret)
    .update(query)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const a = Buffer.from(expected);
  const b = Buffer.from(sign);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return params.get("vk_user_id");
}

function resolveId(claimed: unknown, launch: unknown): string | null {
  const id = String(claimed ?? "");
  if (!VK_ID.test(id)) return null;
  const verified = verifiedVkId(typeof launch === "string" ? launch : undefined);
  if (verified === undefined) return id;
  return verified === id ? id : null;
}

async function invitedCount(vkId: string) {
  const [row] = await db.select({ n: count() }).from(referrals).where(eq(referrals.referrerId, vkId));
  return Number(row?.n ?? 0);
}

async function status(vkId: string) {
  const [invited, claimRow, recent] = await Promise.all([
    invitedCount(vkId),
    db.select({ claimed: referralClaims.claimed }).from(referralClaims).where(eq(referralClaims.vkId, vkId)),
    db
      .select({ id: referrals.inviteeId, at: referrals.createdAt })
      .from(referrals)
      .where(eq(referrals.referrerId, vkId))
      .orderBy(desc(referrals.createdAt))
      .limit(10),
  ]);
  return {
    invited,
    claimed: claimRow[0]?.claimed ?? 0,
    recent: recent.map((r) => ({ id: r.id, at: r.at.getTime() })),
  };
}

export default async (req: Request) => {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const vkId = resolveId(url.searchParams.get("vkId"), url.searchParams.get("launch") ?? undefined);
      if (!vkId) return json({ error: "bad_id" }, 400);
      return json(await status(vkId));
    }

    if (req.method !== "POST") return json({ error: "method" }, 405);

    const body = await req.json().catch(() => ({}));
    const vkId = resolveId(body.vkId, body.launch);
    if (!vkId) return json({ error: "bad_id" }, 400);

    // Новичок пришёл по ссылке: засчитываем пригласившему один раз навсегда
    if (body.action === "join") {
      const ref = String(body.ref ?? "");
      if (!VK_ID.test(ref) || ref === vkId) return json({ credited: false, reason: "bad_ref" });
      const inserted = await db
        .insert(referrals)
        .values({ inviteeId: vkId, referrerId: ref })
        .onConflictDoNothing()
        .returning({ id: referrals.inviteeId });
      return json({ credited: inserted.length > 0 });
    }

    // Обмен новых друзей на награды: сервер атомарно сдвигает счётчик
    // и возвращает диапазон (from, to], за который клиент выдаёт призы
    if (body.action === "claim") {
      const result = await db.transaction(async (tx) => {
        await tx.insert(referralClaims).values({ vkId, claimed: 0 }).onConflictDoNothing();
        const [row] = await tx
          .select({ claimed: referralClaims.claimed })
          .from(referralClaims)
          .where(eq(referralClaims.vkId, vkId))
          .for("update");
        const [{ n }] = await tx.select({ n: count() }).from(referrals).where(eq(referrals.referrerId, vkId));
        const from = row?.claimed ?? 0;
        const to = Math.max(from, Number(n));
        if (to > from) {
          await tx
            .update(referralClaims)
            .set({ claimed: to, updatedAt: new Date() })
            .where(eq(referralClaims.vkId, vkId));
        }
        return { from, to };
      });
      return json({ ...result, ...(await status(vkId)) });
    }

    return json({ error: "action" }, 400);
  } catch (e) {
    console.error("referral error", e);
    return json({ error: "server" }, 500);
  }
};

export const config: Config = {
  path: "/api/referral",
};
