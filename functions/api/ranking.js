export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "";
    const seedParam = url.searchParams.get("seed");

    let stmt;
    if (seedParam != null && seedParam !== "") {
      stmt = env.DB.prepare(
        `SELECT name, mode, seed, score, ok_count AS okCount, created_at
         FROM scores WHERE mode = ? AND seed = ?
         ORDER BY score DESC, created_at ASC LIMIT 50`
      ).bind(mode, Number.parseInt(seedParam, 10));
    } else {
      stmt = env.DB.prepare(
        `SELECT name, mode, seed, score, ok_count AS okCount, created_at
         FROM scores WHERE mode = ?
         ORDER BY score DESC, created_at ASC LIMIT 50`
      ).bind(mode);
    }

    const { results } = await stmt.all();
    return Response.json(results);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
