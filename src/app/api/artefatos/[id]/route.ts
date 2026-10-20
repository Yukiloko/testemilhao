import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { browserArtifacts } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Decrypts a failure artifact for the operator. Only paths inside ARTIFACTS_DIR are served. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = db().select().from(browserArtifacts).where(eq(browserArtifacts.id, Number(id))).get();
  const kind = req.nextUrl.searchParams.get("tipo");
  const file = kind === "screenshot" ? row?.screenshotPath : row?.snapshotPath;
  const root = path.resolve(env().ARTIFACTS_DIR);
  if (!file || !path.resolve(file).startsWith(root + path.sep) || !fs.existsSync(file)) return new NextResponse("não encontrado", { status: 404 });
  const content = decrypt(fs.readFileSync(file), env().APP_ENCRYPTION_KEY);
  return new NextResponse(new Uint8Array(content), {
    headers: { "Content-Type": kind === "screenshot" ? "image/png" : "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
