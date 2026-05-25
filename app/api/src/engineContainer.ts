/**
 * Cloudflare Container binding for the Python engine.
 *
 * The container image is built from `engine/Dockerfile` and exposes a tiny
 * HTTP service on :8080 (see `tracks/container_server.py`).
 *
 * Routes invoke this via `env.ENGINE.idFromName(<caseId>)` so each case gets
 * its own container instance — that gives us per-case isolation and lets
 * `sleepAfter` reclaim idle instances without affecting other cases.
 */
import { Container } from "@cloudflare/containers";

export class EngineContainer extends Container {
  override defaultPort = 8080;
  // Reclaim the container after this much idle time. Engine runs are short
  // (≤60s for the demo trio) so we don't need long-lived instances.
  override sleepAfter = "5m";

  // Container start can take ~1-2s; the Worker should not time out waiting.
  override async onStart() {
    console.log(`[engine-container] started ${this.ctx.id.toString()}`);
  }
  override async onError(err: unknown) {
    console.error(`[engine-container] error`, err);
  }
}
