const DEFAULT_MAX_JSON_BYTES = 32 * 1024 * 1024;

export async function readJsonResponse<T>(response: Response, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<T> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const advertised = response.headers.get("content-length");
  if (advertised && Number(advertised) > maxBytes) throw new Error("Réponse trop volumineuse.");
  if (!response.body) throw new Error("Réponse vide.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Réponse trop volumineuse.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export async function fetchJson<T>(url: string, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<T> {
  return readJsonResponse<T>(await fetch(url, { redirect: "error" }), maxBytes);
}
