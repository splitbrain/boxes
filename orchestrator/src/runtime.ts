import { config, type Config } from './config.ts';
import { dockerRuntime } from './runtime/docker-runtime.ts';
import { kubernetesRuntime } from './runtime/kubernetes-runtime.ts';
import type { Runtime } from './runtime/types.ts';

/**
 * The runtime a deployment starts boxes on: Docker today, and whatever
 * else joins it later.
 *
 * Built fresh from the current config on every call rather than cached, on
 * the same terms as `dockerRuntime` itself: `docker.ts`'s own functions read
 * `cfg` as an argument rather than one taken at some earlier moment, and a
 * cached Runtime would reintroduce exactly the staleness that avoids.
 * Building one is cheap — an object literal of function references — so
 * there is nothing to save by caching it.
 *
 * `cfg` is for a caller holding a config of its own, such as BoxManager,
 * whose DATA_DIR is the one its boxes live under.
 */
let forTests: Runtime | null = null;

export function runtime(cfg: Config = config()): Runtime {
  if (forTests) return forTests;
  return cfg.RUNTIME === 'kubernetes' ? kubernetesRuntime(cfg) : dockerRuntime(cfg);
}

/** Test seam: install a runtime, or null to go back to the real one. */
export function setRuntimeForTests(r: Runtime | null): void {
  forTests = r;
}
