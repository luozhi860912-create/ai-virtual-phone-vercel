import { NextResponse } from "next/server";
import { getLoginClientIp } from "@/lib/server/login-rate-limit";

export const runtime = "nodejs";

const MAX_TEXT_LENGTH = 5000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function consumeRateLimit(ip: string): number {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (!entry && rateLimits.size >= 2000) {
      for (const [key, value] of rateLimits) {
        if (value.resetAt <= now) rateLimits.delete(key);
      }
      if (rateLimits.size >= 2000) return 60;
    }
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimits.set(ip, entry);
  }

  if (entry.count >= MAX_REQUESTS_PER_WINDOW) return Math.ceil((entry.resetAt - now) / 1000);
  entry.count += 1;
  return 0;
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Fish Audio 请求来源无效。" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  const apiKey = process.env.FISH_API_KEY?.trim();
  const referenceId = process.env.FISH_REFERENCE_ID?.trim();
  const model = process.env.FISH_MODEL?.trim() || "s2.1-pro-free";
  if (!apiKey || !referenceId) {
    return NextResponse.json(
      { error: "Fish Audio 尚未配置：请在 Vercel 环境变量中设置 FISH_API_KEY 和 FISH_REFERENCE_ID。" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 25_000) {
    return NextResponse.json({ error: "朗读文本过长。" }, { status: 413, headers: { "Cache-Control": "no-store" } });
  }

  const retryAfter = consumeRateLimit(getLoginClientIp(request));
  if (retryAfter) {
    return NextResponse.json(
      { error: "Fish Audio 请求过于频繁，请稍后再试。" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfter) } },
    );
  }

  let payload: { text?: unknown };
  try {
    payload = await request.json() as { text?: unknown };
  } catch {
    return NextResponse.json({ error: "请求内容不是有效 JSON。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "请输入要朗读的文本。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if ([...text].length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: `朗读文本不能超过 ${MAX_TEXT_LENGTH} 个字符。` }, { status: 413, headers: { "Cache-Control": "no-store" } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 110_000);
  try {
    const upstream = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        model,
      },
      body: JSON.stringify({ text, reference_id: referenceId, format: "mp3" }),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const responseText = await upstream.text().catch(() => "");
      let detail = responseText.slice(0, 300);
      try {
        const error = JSON.parse(responseText) as { message?: string; reason?: string };
        detail = error.message || error.reason || detail;
      } catch { /* Keep the upstream text for non-JSON errors. */ }
      return NextResponse.json(
        { error: `Fish Audio 请求失败 (${upstream.status})${detail ? `：${detail}` : ""}` },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    return new Response(await upstream.arrayBuffer(), {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "Fish Audio 合成超时，请缩短文本后重试。"
      : "无法连接 Fish Audio，请稍后重试。";
    return NextResponse.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  } finally {
    clearTimeout(timeout);
  }
}
