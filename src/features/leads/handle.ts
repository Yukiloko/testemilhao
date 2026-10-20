const HANDLE = /^[a-z0-9._]{1,30}$/;

/** Instagram handles are case-insensitive; store them lowercase, without @ or URL. */
export function normalizeHandle(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const fromUrl = trimmed.match(/instagram\.com\/([^/?#]+)/)?.[1];
  return (fromUrl ?? trimmed).replace(/^@/, "").replace(/\/$/, "");
}

export function isValidHandle(handle: string): boolean {
  return HANDLE.test(handle);
}
