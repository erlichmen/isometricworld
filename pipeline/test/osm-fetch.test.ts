import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scheduler } from "node:timers/promises";
import { fetchOsm } from "../src/osm-fetch.ts";

function fixture(t: TestContext) {
  t.mock.method(scheduler, "wait", async () => {});
  const directory = mkdtempSync(join(tmpdir(), "osm-fetch-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "ground.json") };
}

test("small sequential queries retain full geometry, deduplicate by type/id and reuse cached parts", async t => {
  const { file } = fixture(t);
  let calls = 0, active = 0, peak = 0;
  const bounds: number[][] = [];
  const building = { type: "way", id: 1, geometry: [{lat: 0, lon: 0}, {lat: 0, lon: 1}], tags: { building: "yes" } };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    peak = Math.max(peak, ++active);
    const query = (init.body as URLSearchParams).get("data")!;
    assert.match(query, /\[timeout:25\]\[maxsize:67108864\]/);
    assert.match(query, /out body geom;/);
    assert.doesNotMatch(query, /geom\(/, "do not clip geometry at chunk edges");
    const box = /way\["building"\]\(([^)]+)\)/.exec(query)![1].split(",").map(Number);
    bounds.push(box);
    assert.ok(box[2] - box[0] <= 0.020000001 && box[3] - box[1] <= 0.020000001);
    calls++;
    active--;
    return Response.json({ version: 0.6, elements: [building, { type: "node", id: calls, lat: 0, lon: 0 }] });
  });
  const result = await fetchOsm([0, 0, 0.04, 0.04], box => `way["building"]${box};`, file, "ground");
  assert.equal(calls, 4);
  assert.equal(peak, 1);
  assert.equal(result.elements.length, 5, "same numeric node/way id must remain separate");
  assert.deepEqual(result.elements.find(e => e.type === "way"), building);
  assert.deepEqual(bounds, [[0, 0, 0.02, 0.02], [0, 0.02, 0.02, 0.04], [0.02, 0, 0.04, 0.02], [0.02, 0.02, 0.04, 0.04]]);
  const saved = readFileSync(file, "utf8");
  await fetchOsm([0, 0, 0.04, 0.04], box => `way["building"]${box};`, file, "ground");
  assert.equal(calls, 4);
  assert.equal(readFileSync(file, "utf8"), saved);
});

test("gateway failures switch public servers and successful fallback stays preferred", async t => {
  const { file } = fixture(t);
  const servers: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    const host = new URL(String(url)).hostname;
    servers.push(host);
    assert.equal(init.method, "POST");
    assert.match((init.headers as Record<string, string>)["User-Agent"], /github.com\/erlichmen\/isometricworld/);
    assert.ok(init.signal);
    return host === "overpass-api.de" ? new Response("gateway timeout", {status: 504}) : Response.json({ elements: [] });
  });
  await fetchOsm([0, 0, 0.02, 0.04], box => `way["highway"]${box};`, file, "roads");
  assert.deepEqual(servers, ["overpass-api.de", "overpass.private.coffee", "overpass.private.coffee"]);
  assert.ok(existsSync(file));
});

test("failed chunks never produce a complete cache and retry resumes completed parts", async t => {
  const { file, directory } = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? Response.json({ elements: [{type: "node", id: 1, lat: 0, lon: 0}] }) : new Response("unavailable", {status: 502});
  });
  const selector = (box: string) => `node["natural"="tree"]${box};`;
  await assert.rejects(fetchOsm([0, 0, 0.02, 0.04], selector, file, "trees"), /Completed parts are cached/);
  assert.equal(existsSync(file), false);
  assert.equal(readdirSync(join(directory, "overpass")).length, 1);
  calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ elements: [{type: "node", id: 2, lat: 0, lon: 0}] }); });
  const result = await fetchOsm([0, 0, 0.02, 0.04], selector, file, "trees");
  assert.equal(calls, 1, "the completed first part must not be fetched again");
  assert.deepEqual(result.elements.map(e => e.id), [1, 2]);
});

test("a brief outage gets a bounded second round before failing the chunk", async t => {
  const { file } = fixture(t);
  const servers: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    servers.push(new URL(String(url)).hostname);
    return servers.length < 3 ? new Response("busy", { status: 503 }) : Response.json({ elements: [] });
  });
  await fetchOsm([0, 0, 0.01, 0.01], box => `way["building"]${box};`, file, "osm");
  assert.deepEqual(servers, ["overpass-api.de", "overpass.private.coffee", "overpass-api.de"]);
  assert.ok(existsSync(file));
});

test("HTTP200 runtime remarks, truncated JSON and malformed/oversized responses are never cached", async t => {
  const { directory } = fixture(t);
  const responses = [
    () => Response.json({ elements: [], remark: "runtime error: Query timed out" }),
    () => new Response('{"elements":['),
    () => Response.json({ elements: null }),
    () => Response.json({ elements: [{type: "way", id: "wrong"}] }),
    () => new Response("x".repeat(32 * 1024 * 1024 + 1)),
  ];
  for (let i = 0; i < responses.length; i++) {
    const file = join(directory, String(i), "osm.json");
    t.mock.method(globalThis, "fetch", async () => responses[i]());
    await assert.rejects(fetchOsm([0, 0, 0.01, 0.01], box => `way["building"]${box};`, file, "osm"));
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(join(directory, String(i), "overpass")), false);
  }
});

test("invalid and excessive bounds fail before contacting Overpass", async t => {
  const { file } = fixture(t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("must not request"); });
  await assert.rejects(fetchOsm([1, 1, 0, 0], () => "", file, "osm"), /bbox/);
  await assert.rejects(fetchOsm([0, 0, 5, 5], () => "", file, "osm"), /too large/);
});
