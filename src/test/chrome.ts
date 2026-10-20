import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = [process.env.CHROME_PATH, "/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean) as string[];

export function chromeExecutable(): string | null {
  return CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Starts a real headless Chromium with remote debugging, exactly like the operator's Chrome
 * but with a throwaway profile. Tests then connect over CDP like production does.
 */
export async function startChrome(): Promise<{ cdpUrl: string; stop: () => Promise<void> }> {
  const exe = chromeExecutable();
  if (!exe) throw new Error("No Chromium found; set CHROME_PATH");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bm-chrome-"));
  const child: ChildProcess = spawn(exe, ["--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--no-sandbox", "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const cdpUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chromium did not start")), 20_000);
    let buf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    child.on("exit", (code) => reject(new Error(`Chromium exited with ${code}`)));
  });
  return {
    cdpUrl,
    stop: async () => {
      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}
