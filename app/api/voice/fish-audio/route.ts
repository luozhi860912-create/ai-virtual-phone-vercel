import { NextResponse } from "next/server";
import { getLoginClientIp } from "@/lib/server/login-rate-limit";

export const runtime = "nodejs";

const MAX_TEXT_LENGTH = 5000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
// ponytail: per-instance limit only; use shared storage for a global quota guard.
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

  const authorization = request.headers.get("authorization") || "";
  const apiKey = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "请先填写 Fish Audio API Key。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
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

  let payload: { text?: unknown; referenceId?: unknown; model?: unknown };
  try {
    payload = await request.json() as { text?: unknown; referenceId?: unknown; model?: unknown };
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

  const referenceId = typeof payload.referenceId === "string" ? payload.referenceId.trim() : "";
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : "s2.1-pro-free";

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
      body: JSON.stringify({
        text,
        format: "mp3",
        mp3_bitrate: 128,
        ...(referenceId ? { reference_id: referenceId } : {}),
      }),
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
      const message = /reference not found/i.test(detail)
        ? "参考音色 ID 未找到，或当前 API Key 所属账号无法访问该音色。请核对 API Key 与参考音色 ID 是否属于同一 Fish Audio 账号；也可清空参考音色 ID 后重试。"
        : `Fish Audio 请求失败 (${upstream.status})：${detail}`;
      return NextResponse.json(
        { error: message },
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
