import type { DeploymentImages, ImageInfo } from '../../shared/types.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { runtime } from './runtime.ts';

/** Reports which build of each of the deployment's three images is running. */

/** How long one reading is served before the daemon is asked again, in ms. */
const CACHE_MS = 60_000;

/** The last reading and when it was taken, or null before the first. */
let cached: { at: number; images: DeploymentImages } | null = null;

/** Test seam: forget the cached reading. */
export function resetImagesForTests(): void {
  cached = null;
}

/**
 * Runs one image read, and returns null when it throws.
 *
 * A missing image is a normal answer, for example when the proxy is not up
 * or the daemon cannot be reached. The failure is logged at debug level, as
 * a deployment where the read cannot work would otherwise log a line a minute.
 */
async function safely(
  what: string,
  read: () => Promise<ImageInfo | null>,
): Promise<ImageInfo | null> {
  try {
    return await read();
  } catch (err) {
    log.debug('could not read an image', { what, error: (err as Error).message });
    return null;
  }
}

/** The image behind a container, by container name or id. */
async function imageOfContainer(container: string | null): Promise<ImageInfo | null> {
  if (!container) return null;
  const id = await runtime().images.containerImageId(container);
  return id ? runtime().images.imageInfo(id) : null;
}

/**
 * Returns all three images, from a cache that lasts CACHE_MS.
 *
 * The orchestrator and proxy images are the ones their containers were
 * created from. The proxy container is the one EGRESS_PROXY_CONTAINER names.
 * The box image is BOX_IMAGE itself, so it needs no container. Every open tab
 * polls the health probe that calls this, hence the cache.
 */
export async function deploymentImages(cfg: Config): Promise<DeploymentImages> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.images;

  const [orchestrator, proxy, box] = await Promise.all([
    safely('orchestrator', () => imageOfContainer(runtime().system.selfContainerId())),
    safely('proxy', () => imageOfContainer(cfg.EGRESS_PROXY_CONTAINER)),
    safely('box', () => runtime().images.imageInfo(cfg.BOX_IMAGE)),
  ]);

  cached = { at: now, images: { orchestrator, proxy, box } };
  return cached.images;
}
