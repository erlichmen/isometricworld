# Isometric World: guide for agents

Hand-painted isometric city maps from open data. Read `README.md` (pipeline, layout) and
`ATTRIBUTION.md` (sources, licences) first. Everything is TypeScript; the site is Astro + OpenSeadragon.

## Hard rules

1. **Open data only.** Never use Google Maps/Earth/3D Tiles, Apple, Bing, Mapbox satellite or any other
   proprietary imagery or geometry, not even "just for reference" or as a style source. The project was
   rebuilt once to remove Google-derived content. If a source's licence is unclear, stop and ask.
2. **Every source gets credited.** A new data source is not done until it is in `ATTRIBUTION.md` (source,
   use, licence, obligations), in the region's `credits` in `shared/src/world.json` (shown on the map's
   video mode and on social clips), and in the footer (`web/src/scripts/map.ts`) when it has its own link.
3. **Keep the licence terms intact**: "© OpenStreetMap contributors" visible wherever the map or a video is
   shown (ODbL); Copernicus DEM text as written in `ATTRIBUTION.md`; "Painted with AI" on clips; the
   `pipeline/` stays published as the method to recreate the derived database (ODbL).
4. **Stay inside the files you were asked to change.** Never stop the user's dev server
   (`astro dev stop`): they keep it open while you work (any port; the dev server prints it). Don't touch `web/` while a film render
   (`pipeline/src/film.ts`) is running: hot reload breaks the capture.
5. **Never delete `data/derived/`** (renders, height passes and, above all, paintings: hours of image
   generation each) or `data/web-state/` (what is published). `data/web/` is only the unpublished cache.
6. **Publishing is outward-facing**: `npm run publish` uploads to the production bucket, `npm run deploy` updates the live site. Run it only when the user
   asked for it; it asks `[y/N]` (`--yes` only with the user's go-ahead).
7. Tile coordinates are fixed by a region's `origin` and `headingDeg`. **Never change them for a region
   that has tiles**: every tile, paint and link would move.

## Concepts

- **Region** (`regions` in `shared/src/world.json`, exported as `REGIONS`): one flat map. One camera in a local East-North-Up frame
  at `origin`, one tile pyramid on R2 under `regions/<region>/` (see Hosting). Accurate for cities within ~150 km of
  the origin, which share the map and can be scrolled between.
- **City** (`cities` in `shared/src/world.json`, exported as `CITIES`): a named view into a region. `/<city-slug>` opens the region centred
  on it. Slugs are lowercase, ASCII, hyphenated (`tel-aviv-yafo`); capitalised links redirect (404 page).
- **Hosting** (`pipeline/src/hosting.ts`, README "Hosting"): tiles and region data live only on R2
  (`isometricworldtiles`, `regions/<region>/` under `TILES_ORIGIN` from `.env`), never in git or
  `web/public`. `export` writes changed files to the cache `data/web/regions/<region>/`, `npm run dev` shows
  the cache over production, `publish` uploads and empties the cache.
- **Area** (`areas` in `shared/src/world.json`, exported as `AREAS`): a bbox the pipeline fetches, renders and paints. Belongs
  to one region; CLIs call `openArea(name)`, which switches the camera to that region.

## Adding a city

### 1. Decide: existing region or new region?

Distance from the city to the region's `origin` < ~150 km → same region (only add areas + a city entry).
Otherwise → new region.

### 2. Research (write findings down before coding)

Search for, and record URL + licence of each:

- **Buildings with heights.** Look for the city's open GIS portal (ArcGIS REST, WFS, CKAN, "open data"
  + city name + "buildings" / "building heights" / "3D"). National cadastre / LiDAR-derived building
  datasets are often better than OSM. Fallback: OSM `building` with `height` / `building:levels`.
  Check the licence allows derivative works and publication (CC-BY, ODbL, OGL, PDDL, municipal open
  terms). Note the exact credit wording required.
- **Trees.** City tree inventory or canopy survey (open data); fallback OSM `natural=tree`,
  `landuse=forest`, `leisure=park`. Note dominant species: the paint step colours crowns per species
  (`pipeline/style/trees.png` is the Tel Aviv palette; a very different climate may need its own sheet).
- **Municipal borders.** OSM `admin_level=8` names (local language, exactly as tagged) and the country's
  `name:en` for the Overpass area filter.
- **Street grid orientation** → camera `headingDeg`: pick a heading diagonal (~20–45°) to the main
  grid so two façades of every block show; put the sea/river on the left if possible.
- **Airport** (optional): runway threshold lat/lon and heading for the airliner animation.
- **Terrain**: Copernicus GLO-30 covers the world; nothing to search.

### 3. Code

- `shared/src/world.json` (`regions` and `cities`, or use `npm run editor`): new region (title, `origin` at the city's central square, `headingDeg`, `country`,
  `municipalities`, optional `airport`, `credits`) and the city (`title`, `region`, `center`, `widthM`).
- `shared/src/world.json` (`areas`, or draw in the editor): area(s) with `region` and bbox `[south, west, north, east]`; start small (a ~1 km test
  patch, like `rothschild`) before the whole city.
- `fetch.ts` / `scene.ts`: the Tel Aviv municipal layers (ArcGIS 513 buildings, 574 canopy) are
  Tel Aviv-only. Add the new city's sources behind a per-region/per-area switch, or rely on the OSM
  fallback; never assume the TLV files exist for other areas.
- `ATTRIBUTION.md`: add every new source (see Hard rules).

### 4. Paint with an image model

The look comes from repainting every 1024 px window of the 3D render with an **image-generation model**,
not from the render itself (flat massing and aerial photos were both rejected).

- **What is used:** OpenAI's image model (GPT image generation, the model behind ChatGPT images) through the
  **Codex CLI** (`codex exec`, logged in with a ChatGPT account; `pipeline/src/paint.ts`). No OpenAI API key:
  do not add one or switch to the API unless the user asks. Another provider is fine only if its terms give
  you the output rights and allow publication (record it in `ATTRIBUTION.md`; clips are labelled "Painted
  with AI").
- **Inputs per window** (all four go to the model): the render (`input.png`), the height pass (keeps
  buildings where they are), the style reference `pipeline/style/reference.png`, and the tree species sheet
  `pipeline/style/trees.png`. Painted neighbours' edge strips are copied in so seams continue.
- **Keep the geometry:** the prompt asks for the same buildings, streets, coastline in the same places;
  `paint.ts` checks each result against the render, warps it back if it drifted and repaints windows with
  black bands or patches. Never accept a painting that invents or moves streets.
- **A new climate** (desert, snow, northern trees) may need its own tree sheet, and possibly a region-specific
  style addendum in the prompt; keep `reference.png` as the one house style.
- **Order:** paint a small test patch first, review it with the user, then the rest (`--center` picks where
  the rings start). Painting a whole city takes many hours; run it in the background and re-export as you go
  (`pipeline/watch-export.sh`), previewing with `npm run dev`.

### 5. Run (per area; see README for flags)

```sh
npm -w pipeline run boundaries -- <region>   # new region only
npm run fetch -- <area>
npm run ground -- <area>
npm run scene -- <area>
npm run render -- <area> -j 2
npm run paint -- <area> --center <lat>,<lon>  # slow (Codex); paint the test patch first and review it
npm run export -- <all areas of the region>   # changed tiles into data/web (cache)
npm run dev                                    # check the cache over production (http://localhost:<port>/)
npm run og -- <city-slug>                      # social card web/public/og/<city-slug>.jpg from the tiles (commit it)
npm run publish -- <region>                    # only with the user's go-ahead
npm run deploy                                 # after every publish: pages bake in world.json's file names + preview
```

### 6. Check

- Open `http://localhost:<port>/<city-slug>` (the dev server prints the port): centred on the city, no console errors, borders (`B`), traffic,
  credits correct. `?at=lat,lon,km` and `#metro` work.
- `npm -w pipeline exec tsx src/tour.ts` (adapt its PLACES) for screenshots; look at them.
- Typecheck: `cd pipeline && ../node_modules/.bin/tsc --noEmit -p .` and the same in `web/`.

## Social clips

`pipeline/src/film.ts` renders a deterministic clip from the running site (square 1080, 60 fps, poses +
eased moves, crisp (`--blur 8` for motion blur), light grain, city name fading in at the end, credits always
visible). Edit its `SHOTS` for a new
city, check with `--preview`, then render (~1 h). Output goes to `video/<city-slug>.mp4`; the GitHub GIF is
made from a landscape render (`--size 960x540 --fps 30 --grain 0`), 2.5× faster, 480 px, 12 fps, ffmpeg palette +
`gifsicle --lossy` (keep it ≲ 4 MB).
