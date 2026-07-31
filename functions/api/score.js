export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();

    const name = String(body.name ?? "名無し").trim().slice(0, 12) || "名無し";
    const mode = String(body.mode ?? "");
    const seed = Number.parseInt(body.seed, 10);
    const score = Number.parseInt(body.score, 10);
    const okCount = Number.parseInt(body.okCount, 10);

    const VALID_MODES = ["junior", "senior", "common", "toeic_s", "toeic_g"];
    if (
      !VALID_MODES.includes(mode) ||
      !Number.isInteger(seed) || seed < 0 ||
      !Number.isInteger(score) || score < 0 || score > 1000000 ||
      !Number.isInteger(okCount) || okCount < 0 || okCount > 18
    ) {
      return Response.json({ error: "invalid payload" }, { status: 400 });
    }

    await env.DB.prepare(
      `INSERT INTO scores (name, mode, seed, score, ok_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(name, mode, seed, score, okCount, Date.now()).run();

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
