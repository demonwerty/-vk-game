// netlify/functions/referral.ts
import type { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { and, eq, desc, count } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "../../db";
import { referrals, referralClaims } from "../../db/schema";

// ─────────────────────────────────────────────────────────────
// Утилиты
// ─────────────────────────────────────────────────────────────

function json(body: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}

/**
 * Проверка подписи VK Mini App.
 * Подпись формируется как base64url(HMAC_SHA256(sign_params, secret))
 * Параметр sign удаляется из строки, остальные сортируются по алфавиту
 * и склеиваются в виде key=value через &.
 *
 * Документация: https://dev.vk.com/mini-apps/development/launch-params
 */
function verifyLaunchParams(
  search: string,
  secret: string
): Record<string, string> | null {
  const params = new URLSearchParams(search);
  const sign = params.get("sign");
  if (!sign) return null;

  const pairs: [string, string][] = [];
  params.forEach((v, k) => {
    if (k !== "sign") pairs.push([k, v]);
  });
  pairs.sort(([a], [b]) => a.localeCompare(b));

  const base = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  const expected = createHmac("sha256", secret)
    .update(base)
    .digest("base64url");

  try {
    const a = Buffer.from(sign);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  const out: Record<string, string> = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

/**
 * Возвращает проверенный vk_user_id или null.
 * Если передан launch (строка query/hash) и секрет приложения — проверяем подпись.
 * Иначе используем vkId напрямую (только для dev).
 */
function resolveId(
  vkId?: string | number | null,
  launch?: string | null
): string | null {
  const secret = process.env.VK_APP_SECRET;

  if (launch && secret) {
    const params = verifyLaunchParams(launch, secret);
    if (params && params.vk_user_id) {
      return params.vk_user_id;
    }
    // если подпись есть, но битая — отказ
    if (launch.includes("sign=")) return null;
  }

  // Dev-режим: без подписи
  if (vkId != null && String(vkId).length > 0) {
    return String(vkId);
  }
  return null;
}

async function invitedCount(vkId: string): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(referrals)
    .where(eq(referrals.referrerId, Number(vkId)));
  return Number(rows[0]?.c ?? 0);
}

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

export const handler: Handler = async (
  event: HandlerEvent,
  _context: HandlerContext
) => {
  if (event.httpMethod === "OPTIONS") {
    return json({ ok: true });
  }

  // ── GET: статистика рефералов ─────────────────────────────
  if (event.httpMethod === "GET") {
    const qs = new URLSearchParams(event.queryStringParameters ?? {});
    const verifiedId = resolveId(qs.get("vkId"), qs.get("launch"));

    if (!verifiedId) return json({ error: "bad_id" }, 400);

    const [invited, claimRow, recent] = await Promise.all([
      invitedCount(verifiedId),
      db
        .select({ claimed: referralClaims.claimed })
        .from(referralClaims)
        .where(eq(referralClaims.vkId, Number(verifiedId))),
      db
        .select({
          id: referrals.inviteeId,
          createdAt: referrals.createdAt,
        })
        .from(referrals)
        .where(eq(referrals.referrerId, Number(verifiedId)))
        .orderBy(desc(referrals.createdAt))
        .limit(20),
    ]);

    const claimed = claimRow[0]?.claimed ?? 0;

    return json({
      vkId: Number(verifiedId),
      invited,
      claimed,
      available: Math.max(0, invited - claimed),
      recent: recent.map((r) => ({
        id: r.id,
        at: r.createdAt?.toISOString?.() ?? null,
      })),
    });
  }

  // ── POST: register / claim ────────────────────────────────
  if (event.httpMethod === "POST") {
    let body: any = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      return json({ error: "bad_json" }, 400);
    }

    const action = body.action ?? "register";
    const launch =
      typeof body.launch === "string" ? body.launch : event.rawQuery ?? "";
    const verifiedId = resolveId(body.vkId, launch);
    if (!verifiedId) return json({ error: "bad_id" }, 400);

    // ── Регистрация реферала ──
    if (action === "register") {
      const ref = body.ref;
      if (!ref) return json({ error: "no_ref" }, 400);

      const inviteeId = Number(verifiedId);
      const referrerId = Number(ref);

      if (!Number.isFinite(inviteeId) || !Number.isFinite(referrerId)) {
        return json({ error: "bad_ids" }, 400);
      }
      if (inviteeId === referrerId) {
        return json({ error: "self_referral" }, 400);
      }

      try {
        await db.insert(referrals).values({ inviteeId, referrerId });
        return json({ ok: true, registered: true });
      } catch (e: any) {
        // уникальный конфликт = уже был засчитан
        if (
          e?.code === "23505" ||
          String(e?.message || "").includes("duplicate key")
        ) {
          return json({ ok: true, registered: false, reason: "already" });
        }
        console.error("register error", e);
        return json({ error: "db_error" }, 500);
      }
    }

    // ── Получение награды ──
    if (action === "claim") {
      const vkNum = Number(verifiedId);

      const [invited, claimRow] = await Promise.all([
        invitedCount(verifiedId),
        db
          .select({ claimed: referralClaims.claimed })
          .from(referralClaims)
          .where(eq(referralClaims.vkId, vkNum)),
      ]);

      const claimed = claimRow[0]?.claimed ?? 0;
      const availableToClaim = invited - claimed;
      if (availableToClaim <= 0) {
        return json({ error: "no_rewards" }, 400);
      }

      // ── Награда ──
      // Настройте под свою игру. Пример: 100 монет за друга.
      const REWARD_PER_FRIEND = 100;
      const rewardAmount = availableToClaim * REWARD_PER_FRIEND;

      // TODO: вставьте здесь начисление rewardAmount игроку verifiedId
      // через вашу игровую БД/API, например:
      //
      // await db.update(players)
      //   .set({ coins: sql`${players.coins} + ${rewardAmount}` })
      //   .where(eq(players.vkId, vkNum));
      //
      // Ниже — заглушка, просто сохраняем факт клейма.

      await db
        .insert(referralClaims)
        .values({ vkId: vkNum, claimed: invited })
        .onConflictDoUpdate({
          target: referralClaims.vkId,
          set: { claimed: invited, updatedAt: new Date() },
        });

      return json({
        success: true,
        claimed: invited,
        rewarded: availableToClaim,
        reward: rewardAmount,
      });
    }

    return json({ error: "unknown_action" }, 400);
  }

  return json({ error: "method_not_allowed" }, 405);
};
