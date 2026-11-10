import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaceSearch } from "../server/search.ts";

const feature = { type: "Feature", geometry: { type: "Point", coordinates: [34.9896, 32.794] }, properties: { name: "Haifa", city: "Haifa", state: "Haifa District", country: "Israel" } };
const collection = (features: unknown[] = [feature]) => ({ type: "FeatureCollection", features });

test("search validates queries, encodes requests, returns latitude/longitude and caches repeat queries", async () => {
  let requests = 0;
  const service = new PlaceSearch((async (input, init) => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://photon.komoot.io");
    assert.equal(url.pathname, "/api/");
    assert.equal(url.searchParams.get("q"), "Haifa & coast");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.match((init?.headers as Record<string, string>)["User-Agent"], /IsometricWorld/);
    return Response.json(collection());
  }) as typeof fetch);
  for (const invalid of [undefined, {}, " ", "a", "a".repeat(201)]) await assert.rejects(service.search(invalid), /between 2 and 200/);
  const result = await service.search(" Haifa   & coast ");
  assert.deepEqual(result, [{ label: "Haifa, Haifa District, Israel", lat: 32.794, lon: 34.9896 }]);
  assert.deepEqual(await service.search("haifa & coast"), result);
  assert.equal(requests, 1);
  await assert.rejects(service.search("Tel Aviv"), error => (error as {status: number}).status === 429);
});

test("simultaneous searches cannot generate multiple upstream requests", async () => {
  let finish!: (response: Response) => void;
  let requests = 0;
  const service = new PlaceSearch((() => { requests++; return new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch);
  const first = service.search("Haifa");
  await assert.rejects(service.search("Jerusalem"), /wait a moment/);
  finish(Response.json(collection([])));
  assert.deepEqual(await first, []);
  assert.equal(requests, 1);
});

test("empty searches and upstream failures have clear bounded behavior", async () => {
  assert.deepEqual(await new PlaceSearch((async () => Response.json(collection([]))) as typeof fetch).search("Unknown"), []);
  const invalid = [
    async () => new Response("Unavailable", { status: 503 }),
    async () => new Response("{"),
    async () => Response.json({ features: [] }),
    async () => Response.json(collection([{ ...feature, geometry: { type: "Point", coordinates: [400, 91] } }])),
    async () => Response.json(collection([{ ...feature, properties: {} }])),
    async () => Response.json(collection(Array(6).fill(feature))),
    async () => new Response("x".repeat(256 * 1024 + 1)),
    async () => { throw new Error("timeout"); },
  ];
  for (const request of invalid) {
    await assert.rejects(new PlaceSearch(request as typeof fetch).search("Haifa"), error => (error as {status: number}).status === 502);
  }
});
