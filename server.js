const FREE_DAILY_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT || "5", 10);

// on identifie l'utilisateur WP (sinon, on refuse)
if (!wpUserId) {
  return res.status(401).json({ ok: false, error: "wp_user_required" });
}

// 1) vérifier premium
const userRow = await pool.query(
  "select is_premium from oly_users where wp_user_id=$1",
  [String(wpUserId)]
);

const isPremium = userRow.rowCount ? !!userRow.rows[0].is_premium : false;

// 2) si pas premium -> limiter
if (!isPremium) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  await pool.query(
    "insert into oly_usage_daily(day, wp_user_id, count) values($1,$2,0) on conflict (day, wp_user_id) do nothing",
    [day, String(wpUserId)]
  );

  const usage = await pool.query(
    "select count from oly_usage_daily where day=$1 and wp_user_id=$2",
    [day, String(wpUserId)]
  );

  const count = usage.rows[0]?.count ?? 0;

  if (count >= FREE_DAILY_LIMIT) {
    return res.status(402).json({
      ok: false,
      error: "free_limit_reached",
      limit: FREE_DAILY_LIMIT
    });
  }

  await pool.query(
    "update oly_usage_daily set count = count + 1 where day=$1 and wp_user_id=$2",
    [day, String(wpUserId)]
  );
}
