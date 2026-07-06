import { NextRequest, NextResponse } from "next/server";
import { scanLive, scanMock, type ScanOptions } from "@/lib/scan";

// Run on the Node.js runtime (not edge) so we get generous outbound fetch
// and up to 60s to scan many markets.
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function num(v: string | null, fallback: number): number {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const opts: ScanOptions = {
    tag: sp.get("tag") ?? "sports",
    events: num(sp.get("events"), 25),
    markets: num(sp.get("markets"), 18),
    windowHours: num(sp.get("window"), 24),
    minVolume: num(sp.get("minVolume"), 1_000),
    minScore: num(sp.get("minScore"), 30),
    top: num(sp.get("top"), 20),
  };
  const source = sp.get("source");

  try {
    if (source === "mock") {
      return NextResponse.json(scanMock(opts));
    }
    const result = await scanLive(opts);
    return NextResponse.json(result);
  } catch (e) {
    // Live scan failed (e.g. network blocked) - fall back to mock so the UI
    // still renders, and flag it in the payload.
    const mock = scanMock(opts);
    return NextResponse.json({
      ...mock,
      errors: [
        `live scan failed, showing demo data: ${(e as Error).message}`,
      ],
    });
  }
}
