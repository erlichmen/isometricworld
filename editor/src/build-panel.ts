import OpenSeadragon from "openseadragon";
import type { BuildJob, BuildSnapshot } from "../server/builds.ts";

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => get<HTMLButtonElement>(id);

export function setupBuildPanel(context: () => { area: string | null; revision: string; dirty: boolean; ready: boolean }, activeChanged: (active: boolean) => void) {
  let state: BuildSnapshot = { active: null, job: null };
  let checked = false;
  let events: EventSource | undefined;
  let eventArea: string | null | undefined;
  let reconnect: number | undefined;
  let generation = 0;
  let starting = false;
  let active = false;
  let error = "";
  let startError = "";
  let startArea: string | null = null;
  let viewer: OpenSeadragon.Viewer | undefined;
  const preview = get<HTMLDialogElement>("render-preview-dialog");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/editor/${path}`, init);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Build request failed (${response.status})`);
    return data;
  }

  function update() {
    const current = context();
    const job = current.area && state.job?.area === current.area ? state.job : null;
    const busy = starting || !!state.active;
    if (busy !== active) { active = busy; activeChanged(active); }
    button("build-area").disabled = !current.area || current.dirty || !current.ready || !checked || busy;
    button("build-area").textContent = starting ? "Starting build…" : job && (job.status === "failed" || job.status === "interrupted") ? "Retry build" : "Build isometric preview";
    button("view-render").hidden = !job?.previewUrl || job.status !== "succeeded";
    get("build-status").textContent = (current.area === startArea ? startError : "") || error || (starting ? "Starting the local build…"
      : state.active && state.active.area !== current.area ? `Building ${state.active.title}. One pipeline build runs at a time.`
      : !current.area ? "Select an area to build its raw isometric map."
      : current.dirty ? "Save your changes before building."
      : !checked ? "Checking local builds…"
      : job?.status === "running" ? `Building ${job.title} · ${job.stage}… You can reload this page; the build continues.`
      : job?.status === "succeeded" ? "Raw isometric preview is ready. Open it to pan and zoom."
      : job?.status === "failed" || job?.status === "interrupted" ? `${job.status === "interrupted" ? "Build interrupted" : "Build failed"}: ${job.message || "See the log for details."}`
      : "Fetch open data, build terrain and geometry, then render a raw preview. Start with a small area.");
    const displayed = job ?? state.active;
    get("build-stages").hidden = !displayed;
    for (const step of document.querySelectorAll<HTMLElement>("#build-stages [data-stage]")) {
      const name = step.dataset.stage!;
      step.dataset.state = displayed?.completedStages.includes(name as BuildJob["stage"]) ? "complete" : displayed?.stage === name ? displayed.status : "pending";
    }
    const log = get("build-log");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    if (log.textContent !== (displayed?.log || "No build output yet.")) {
      log.textContent = displayed?.log || "No build output yet.";
      if (atBottom) log.scrollTop = log.scrollHeight;
    }
    get("build-log-details").hidden = !displayed;
  }

  function refresh() {
    if (starting || !context().ready) return;
    const area = context().area;
    if (events && eventArea === area && events.readyState !== EventSource.CLOSED) return;
    window.clearTimeout(reconnect);
    reconnect = undefined;
    events?.close();
    const requestGeneration = ++generation;
    eventArea = area;
    const source = events = new EventSource(`/api/editor/builds/events${area ? `?area=${encodeURIComponent(area)}` : ""}`);
    source.addEventListener("build-state", event => {
      if (requestGeneration !== generation || starting) return;
      try {
        const result = JSON.parse((event as MessageEvent).data) as BuildSnapshot;
        if (!result || !Object.hasOwn(result, "active") || !Object.hasOwn(result, "job")) throw new Error("Invalid build state");
        state.active = result.active;
        if (context().area === area) state.job = result.job;
        checked = true;
        error = "";
      } catch { checked = false; error = "Could not read live build updates. Waiting for the next update…"; }
      update();
    });
    source.addEventListener("build-error", () => {
      if (requestGeneration !== generation) return;
      checked = false;
      error = "Could not read live build updates. Retrying…";
      update();
    });
    source.onerror = () => {
      if (requestGeneration !== generation) return;
      checked = false;
      error = "Live build updates disconnected. Reconnecting…";
      update();
      if (source.readyState === EventSource.CLOSED) {
        window.clearTimeout(reconnect);
        reconnect = window.setTimeout(() => { if (requestGeneration === generation) refresh(); }, 1000);
      }
    };
  }

  button("build-area").addEventListener("click", async () => {
    const current = context();
    if (!current.area || current.dirty || active || starting || !checked) return;
    starting = true;
    generation++;
    window.clearTimeout(reconnect);
    events?.close();
    events = undefined;
    error = "";
    startError = "";
    startArea = current.area;
    update();
    try {
      const job = await request<BuildJob>("builds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ area: current.area, revision: current.revision }) });
      state = { active: job.status === "running" ? job : null, job };
    } catch (e) { startError = e instanceof Error ? e.message : String(e); }
    finally { starting = false; update(); }
    // A fresh snapshot after POST cannot be overwritten by a queued pre-start event.
    refresh();
  });

  button("view-render").addEventListener("click", () => {
    const job = state.job;
    if (!job?.previewUrl || job.status !== "succeeded") return;
    get("render-preview-title").textContent = job.title;
    get("render-preview-credits").textContent = job.credits.join("\n");
    get("render-preview-error").hidden = true;
    preview.showModal();
    viewer = OpenSeadragon({
      element: get("render-preview"),
      showNavigationControl: false,
      showFullPageControl: false,
      visibilityRatio: 0.5,
      constrainDuringPan: true,
      tileSources: { type: "image", url: job.previewUrl },
    });
    viewer.addHandler("open-failed", () => { get("render-preview-error").hidden = false; });
    get("render-preview").focus();
  });
  button("close-render-preview").addEventListener("click", () => preview.close());
  preview.addEventListener("close", () => { viewer?.destroy(); viewer = undefined; });
  button("render-zoom-in").addEventListener("click", () => { viewer?.viewport?.zoomBy(1.5); viewer?.viewport?.applyConstraints(); });
  button("render-zoom-out").addEventListener("click", () => { viewer?.viewport?.zoomBy(1 / 1.5); viewer?.viewport?.applyConstraints(); });
  button("render-home").addEventListener("click", () => viewer?.viewport?.goHome());
  window.addEventListener("pagehide", () => { generation++; window.clearTimeout(reconnect); events?.close(); events = undefined; });
  window.addEventListener("pageshow", refresh);
  return { refresh, update };
}
