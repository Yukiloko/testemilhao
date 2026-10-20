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

/** Serves a minimal, accessible imitation of the Instagram pages the agent touches. */
export async function installMockInstagram(context: BrowserContext, state: MockInstagram): Promise<void> {
  await context.route(`${BASE}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const html = (body: string) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    if (url.pathname === "/__mock/sent") {
      state.sent.push(JSON.parse(route.request().postData() ?? "{}") as { handle: string; text: string });
      return route.fulfill({ status: 204 });
    }
    if (state.mode === "logged_out" || url.pathname.startsWith("/accounts/login")) {
      return html(page("Login", "<form><input name='username'><input name='password' type='password'><button>Entrar</button></form>"));
    }
    if (state.mode === "restricted") return html(page("Instagram", "<div role='dialog'><h2>Tente novamente mais tarde</h2><p>Restringimos determinadas atividades para proteger nossa comunidade.</p></div>"));

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "explore" && parts[1] === "tags" && parts[2]) {
      const posts = state.hashtags.get(parts[2]) ?? [];
      return html(page(`#${parts[2]}`, `<main>${posts.map((author, i) => `<a href="/p/${parts[2]}${i}-${author}/">post</a>`).join("")}</main>`));
    }
    if (parts[0] === "p" && parts[1]) {
      const author = parts[1].split("-").slice(1).join("-");
      return html(page("Post", `<main><article><header><a href="/${author}/">${author}</a></header></article></main>`));
    }
    if (parts[0] === "direct" && parts[1] === "t" && parts[2]) return html(directHtml(parts[2], state.mode !== "no_confirmation"));
    const profile = parts[0] ? state.profiles.get(parts[0]) : undefined;
    if (profile) return html(profileHtml(profile));
    return html(page("Instagram", "<main><h2>Esta página não está disponível.</h2></main>"));
  });
}

export function newMockState(): MockInstagram {
  return { profiles: new Map(), hashtags: new Map(), sent: [], mode: "normal" };
}
