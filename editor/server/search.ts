import { EditorError } from "./store.ts";

export interface PlaceResult { label: string; lat: number; lon: number }

export class PlaceSearch {
  private cache = new Map<string, { expires: number; results: PlaceResult[] }>();
  private nextRequestAt = 0;
  private busy = false;
  constructor(private request: typeof fetch = fetch) {}

  async search(query: unknown): Promise<PlaceResult[]> {
    if (typeof query !== "string" || query.trim().length < 2 || query.length > 200) {
      throw new EditorError("Enter a place or address between 2 and 200 characters.");
    }
    const normalized = query.trim().replace(/\s+/g, " ");
    const key = normalized.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.results;
    if (this.busy || Date.now() < this.nextRequestAt) throw new EditorError("Please wait a moment before searching again.", 429);
    this.busy = true;
    this.nextRequestAt = Date.now() + 1000;
    try {
      const url = new URL("https://photon.komoot.io/api/");
      url.search = new URLSearchParams({ q: normalized, limit: "5", lang: "en" }).toString();
      const response = await this.request(url, {
        headers: { Accept: "application/json", "User-Agent": "IsometricWorld/1.0 (local open-data region editor)" },
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("Place search service is unavailable. Try again later.");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 256 * 1024) { await reader.cancel(); throw new Error("Place search response is too large."); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const results = parseResults(JSON.parse(Buffer.concat(chunks).toString()));
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { results, expires: Date.now() + 24 * 60 * 60 * 1000 });
      return results;
    } catch (error) {
      throw new EditorError(error instanceof Error && error.message.startsWith("Place search") ? error.message : "Place search failed or timed out. Try again later.", 502);
    } finally { this.busy = false; }
  }
}

function parseResults(data: any): PlaceResult[] {
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features) || data.features.length > 5) throw new Error("Place search returned invalid results.");
  return data.features.map((feature: any) => {
    const coordinates = feature?.geometry?.coordinates;
    const p = feature?.properties;
    if (feature?.geometry?.type !== "Point" || !Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite)
      || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90 || !p || typeof p !== "object") throw new Error("Place search returned invalid coordinates.");
    const text = (key: string) => typeof p[key] === "string" ? p[key].trim().slice(0, 500) : "";
    const label = [...new Set([text("name"), [text("housenumber"), text("street")].filter(Boolean).join(" "), text("city") || text("county"), text("state"), text("country")].filter(Boolean))].join(", ");
    if (!label) throw new Error("Place search returned an unnamed result.");
    return { label, lat: coordinates[1], lon: coordinates[0] };
  });
}
