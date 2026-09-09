import { shortSize } from '@/lib/rough';
import type { DeploymentImages, ImageInfo } from '../../../shared/types.ts';

/**
 * What the deployment is built from: one line naming each image's digest,
 * when it was built and how big it is.
 *
 * A deployment that follows `latest` moves when a watchtower says so rather
 * than when a person does, so which build is answering is a thing nobody was
 * told. That is the question this line exists for, and the digest is the
 * whole of the answer — the build time beside it is what makes a stale
 * deployment obvious at a glance, and the size is what makes a session image
 * that has quietly doubled obvious in the same way.
 */

/** The images, in the order the line names them, and under the name it uses. */
const ORDER: Array<keyof DeploymentImages> = ['orchestrator', 'proxy', 'session'];

/** How much of a digest is shown, in hex characters. */
const SHORT_DIGEST = 12;

/**
 * A digest at the length Docker itself abbreviates an id to, with the
 * algorithm dropped: every digest here is `sha256:`, so repeating it three
 * times says nothing.
 */
function short(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, SHORT_DIGEST);
}

/**
 * A moment as `YYYY-MM-DD HH:MM`, in the reader's own timezone.
 *
 * Written out rather than left to the locale, because the question the line
 * answers is which of two builds is newer: a fixed format sorts the way it
 * reads, where `8/12/2026` and `12/8/2026` are the same day to two readers
 * and different days to one of them.
 */
function stamp(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** One image, with the full digest on hover. */
function Entry({ label, image }: { label: string; image: ImageInfo }) {
  // Both are dropped rather than shown as a dash where the daemon said
  // nothing: the digest alone is still the answer, and a row of placeholders
  // would be the loudest thing in a footer.
  const facts: string[] = [];
  if (image.builtAt !== null) facts.push(stamp(image.builtAt));
  if (image.sizeBytes !== null) facts.push(shortSize(image.sizeBytes));

  return (
    <span title={image.digest} className="whitespace-nowrap">
      {label} <span className="font-mono">{short(image.digest)}</span>
      {facts.map((fact) => ` · ${fact}`).join('')}
    </span>
  );
}

/**
 * The line itself, or nothing at all where no image could be read — a
 * checkout running outside Docker has no daemon to ask, and an empty rule
 * across the page would be the only thing it said.
 */
export function ImageFooter({ images }: { images: DeploymentImages }) {
  const present = ORDER.flatMap((name) => {
    const image = images[name];
    return image ? [{ name, image }] : [];
  });
  if (present.length === 0) return null;

  return (
    <footer className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
      {present.map(({ name, image }) => (
        <Entry key={name} label={name} image={image} />
      ))}
    </footer>
  );
}
