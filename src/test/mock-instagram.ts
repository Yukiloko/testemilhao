import type { BrowserContext, Route } from "playwright-core";

export type MockProfile = { handle: string; name: string; bio: string; category?: string; followers: number; posts?: number; captions?: string[] };

export type MockInstagram = {
  profiles: Map<string, MockProfile>;
  hashtags: Map<string, string[]>;
  sent: { handle: string; text: string }[];
  mode: "normal" | "restricted" | "logged_out" | "no_confirmation";
};

export const BASE = "https://www.instagram.com";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(title)}</title>${head}</head><body>${body}</body></html>`;
}

function profileHtml(p: MockProfile): string {
  const head = `<meta property="og:title" content="${esc(p.name)} (@${p.handle}) • Instagram photos and videos">
<meta property="og:description" content="${p.followers.toLocaleString("en-US")} Followers, 120 Following, ${p.posts ?? 40} Posts - See Instagram photos and videos from ${esc(p.name)} (@${p.handle})">`;
  const imgs = (p.captions ?? []).map((c) => `<img alt="${esc(c)}" src="data:,">`).join("");
  return page(
    p.name,
    `<main><header><h1>${esc(p.name)}</h1><span data-testid="bio">${esc(p.bio)}</span>${p.category ? `<div data-testid="category">${esc(p.category)}</div>` : ""}
<div role="button" tabindex="0" aria-label="Mensagem" onclick="location.href='/direct/t/${p.handle}/'">Mensagem</div></header><article>${imgs}</article></main>`,
    head,
  );
}

function directHtml(handle: string, confirm: boolean): string {
  return page(
    "Direct",
    `<main><div id="thread" role="log"></div>
<div role="textbox" contenteditable="true" aria-label="Mensagem" id="box"></div>
<script>
const box = document.getElementById('box');
box.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = box.innerText;
    box.innerText = '';
    await fetch('/__mock/sent', { method: 'POST', body: JSON.stringify({ handle: ${JSON.stringify(handle)}, text }) });
    ${confirm ? "const div = document.createElement('div'); div.textContent = text; document.getElementById('thread').appendChild(div);" : ""}
  }
});
</script></main>`,
  );
}

export type MockResponse = { status: number; html?: string };

/** Pure renderer shared by the in-browser route mock (unit tests) and the HTTP server (E2E). */
export function renderMock(pathname: string, state: MockInstagram, postBody?: string): MockResponse {
  if (pathname === "/__mock/sent") {
    state.sent.push(JSON.parse(postBody ?? "{}") as { handle: string; text: string });
    return { status: 204 };
  }
  if (state.mode === "logged_out" || pathname.startsWith("/accounts/login")) {
    return { status: 200, html: page("Login", "<form><input name='username'><input name='password' type='password'><button>Entrar</button></form>") };
  }
  if (state.mode === "restricted") {
    return { status: 200, html: page("Instagram", "<div role='dialog'><h2>Tente novamente mais tarde</h2><p>Restringimos determinadas atividades para proteger nossa comunidade.</p></div>") };
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "explore" && parts[1] === "tags" && parts[2]) {
    const posts = state.hashtags.get(parts[2]) ?? [];
    return { status: 200, html: page(`#${parts[2]}`, `<main>${posts.map((author, i) => `<a href="/p/${parts[2]}${i}-${author}/">post</a>`).join("")}</main>`) };
  }
  if (parts[0] === "p" && parts[1]) {
    const author = parts[1].split("-").slice(1).join("-");
    return { status: 200, html: page("Post", `<main><article><header><a href="/${author}/">${author}</a></header></article></main>`) };
  }
  if (parts[0] === "direct" && parts[1] === "t" && parts[2]) return { status: 200, html: directHtml(parts[2], state.mode !== "no_confirmation") };
  const profile = parts[0] ? state.profiles.get(parts[0]) : undefined;
  if (profile) return { status: 200, html: profileHtml(profile) };
  return { status: 200, html: page("Instagram", "<main><h2>Esta página não está disponível.</h2></main>") };
}

/** Serves the mock on Instagram's real origin inside the browser, via request interception. */
export async function installMockInstagram(context: BrowserContext, state: MockInstagram): Promise<void> {
  await context.route(`${BASE}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const res = renderMock(url.pathname, state, route.request().postData() ?? undefined);
    if (!res.html) return route.fulfill({ status: res.status });
    return route.fulfill({ status: res.status, contentType: "text/html; charset=utf-8", body: res.html });
  });
}

export function newMockState(): MockInstagram {
  return { profiles: new Map(), hashtags: new Map(), sent: [], mode: "normal" };
}
