import { test } from "node:test";
import assert from "node:assert/strict";
import { WORLD } from "../src/index.ts";
import { validateWorld } from "../src/validate.ts";

test("current definitions remain valid and keep the fixed camera", () => {
  validateWorld(WORLD);
  assert.deepEqual(WORLD.regions["israel-center"].origin, { lat: 32.0778, lon: 34.774, h: 0 });
  assert.equal(WORLD.regions["israel-center"].headingDeg, 340);
  assert.equal(WORLD.defaultCity, "tel-aviv-yafo");
});

const invalidChanges: Record<string, (w: any) => void> = {
  "nonfinite coordinate": w => { w.regions["israel-center"].origin.lat = NaN; },
  "invalid heading": w => { w.regions["israel-center"].headingDeg = 360; },
  "backward bbox": w => { w.areas.rothschild.bbox.reverse(); },
  "unknown region": w => { w.areas.rothschild.region = "missing"; },
  "unknown property": w => { w.regions["israel-center"].extra = true; },
  "missing credits": w => { w.regions["israel-center"].credits = []; },
  "missing default city": w => { w.defaultCity = "missing"; },
  "invalid slug": w => { w.cities.BAD = w.cities["tel-aviv-yafo"]; },
  "invalid width": w => { w.cities["tel-aviv-yafo"].widthM = 0; },
};
for (const [label, change] of Object.entries(invalidChanges)) {
  test(`reject ${label}`, () => {
    const draft = structuredClone(WORLD);
    change(draft);
    assert.throws(() => validateWorld(draft));
  });
}
