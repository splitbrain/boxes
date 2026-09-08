import { FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import type {
  AgentBundlePreview,
  AgentItem,
  AgentItemKind,
  AgentSetDetail,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { BackLink } from '@/components/BackLink';
import { useUp } from '@/hooks/use-up';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * One set: its AGENTS.md, its skills and its slash commands.
 *
 * Everything here is a file the agent will read, so the editor is textareas
 * rather than forms — there is no schema to offer, and inventing one would
 * only get in the way of pasting a skill somebody already wrote.
 *
 * Nothing saves as you type. Each section has its own Save, and what is saved
 * reaches a box the next time that box starts; the note at the top says so,
 * because a box already running would otherwise look like it ignored the edit.
 */
export function AgentSetEditor() {
  const { setId = '' } = useParams();
  /** Out to the list of sets, popped rather than pushed; see useUp. */
  const up = useUp('/agents');

  const [set, setSet] = useState<AgentSetDetail | null>(null);
  const [preview, setPreview] = useState<AgentBundlePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The AGENTS.md as edited, against which the Save button decides it is dirty. */
  const [agentsMd, setAgentsMd] = useState('');
  const [name, setName] = useState('');

  const [editing, setEditing] = useState<{ kind: AgentItemKind; item: AgentItem | null } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<AgentItem | null>(null);

  /** Loads the set and, for a non-global one, what it merges to. */
  const load = useCallback(async (): Promise<void> => {
    try {
      const detail = await api.getAgentSet(setId);
      setSet(detail);
      setAgentsMd(detail.agentsMd);
      setName(detail.name);
      setPreview(detail.global ? null : await api.agentSetPreview(setId));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [setId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one mutation and reloads, so the view never guesses at the result. */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!set) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink up={up} label="Agent configuration" />
        {error ? (
          <Notice className="rounded-md border px-3 py-2">{error}</Notice>
        ) : (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
      </div>
    );
  }

  const skills = set.items.filter((i) => i.kind === 'skill');
  const commands = set.items.filter((i) => i.kind === 'command');
  const overridden = new Set(preview?.overrides.map((o) => `${o.kind}/${o.name}`) ?? []);

  return (
    <div className="flex flex-col gap-4">
      <BackLink up={up} label="Agent configuration" />

      <h1 className="text-xl font-semibold">{set.name}</h1>

      <p className="text-sm text-muted-foreground">
        {set.global
          ? 'Everything here goes into every box.'
          : 'A box that names this set gets it on top of the global set.'}{' '}
        Changes reach a box the next time it starts.
      </p>

      {error ? (
        <Notice className="rounded-md border px-3 py-2">{error}</Notice>
      ) : null}

      {/* Renaming the global set is allowed — it is only a label — but it
          cannot be deleted, and that is decided in the list. */}
      <Card className="flex flex-col gap-3 p-4">
        <Label htmlFor="set-name">Name</Label>
        <div className="flex gap-2">
          <Input
            id="set-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || name.trim() === '' || name === set.name}
            onClick={() => void act(() => api.updateAgentSet(setId, { name: name.trim() }))}
          >
            Rename
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">AGENTS.md</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Standing instructions. Installed as the agent&apos;s own memory, so it applies wherever
          in the box the agent is working, not only in a checked-out project.
        </p>
        <Textarea
          value={agentsMd}
          // field-sizing-content makes rows= inert, so a minimum is what
          // gives this a usable editing area before anything is typed.
          className="min-h-40 font-mono text-xs"
          placeholder={"# House rules\n\n- Run the tests before you say you are done.\n"}
          onChange={(e) => setAgentsMd(e.target.value)}
        />
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={busy || agentsMd === set.agentsMd}
            onClick={() => void act(() => api.updateAgentSet(setId, { agentsMd }))}
          >
            {agentsMd === set.agentsMd ? 'Saved' : 'Save AGENTS.md'}
          </Button>
        </div>
      </Card>

      <ItemSection
        kind="skill"
        title="Skills"
        blurb="A SKILL.md the agent loads on its own when the work matches. It needs YAML front matter with a name and a description — that description is the only thing the agent sees before deciding to read it."
        items={skills}
        overridden={overridden}
        busy={busy}
        onAdd={() => setEditing({ kind: 'skill', item: null })}
        onEdit={(item) => setEditing({ kind: 'skill', item })}
        onDelete={setConfirmDelete}
      />

      <ItemSection
        kind="command"
        title="Slash commands"
        blurb="A prompt the agent runs when you type its name after a slash in the composer."
        items={commands}
        overridden={overridden}
        busy={busy}
        onAdd={() => setEditing({ kind: 'command', item: null })}
        onEdit={(item) => setEditing({ kind: 'command', item })}
        onDelete={setConfirmDelete}
      />

      {preview ? <Merged preview={preview} /> : null}

      {editing ? (
        <ItemDialog
          kind={editing.kind}
          item={editing.item}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            if (await act(() => api.putAgentItem(setId, body))) setEditing(null);
          }}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete ${confirmDelete.kind} ${confirmDelete.name}?`}
          description="It is removed from this set, and from every box that uses the set at its next start."
          confirmLabel="Delete"
          danger
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() =>
            void act(async () => {
              await api.deleteAgentItem(setId, confirmDelete.kind, confirmDelete.name);
              setConfirmDelete(null);
            })
          }
        />
      ) : null}
    </div>
  );
}

/** One list of skills or of commands, with its own add button. */
function ItemSection({
  kind,
  title,
  blurb,
  items,
  overridden,
  busy,
  onAdd,
  onEdit,
  onDelete,
}: {
  kind: AgentItemKind;
  title: string;
  blurb: string;
  items: AgentItem[];
  /** Keys of the items this set takes over from the global one. */
  overridden: Set<string>;
  busy: boolean;
  onAdd: () => void;
  onEdit: (item: AgentItem) => void;
  onDelete: (item: AgentItem) => void;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onAdd}>
          <Plus />
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{blurb}</p>

      {items.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">None in this set.</p>
      ) : null}

      {items.map((item) => (
        <div
          key={item.name}
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {kind === 'command' ? `/${item.name}` : item.name}
          </span>
          {overridden.has(`${item.kind}/${item.name}`) ? (
            <span className="shrink-0 text-xs text-muted-foreground">replaces the global one</span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Edit ${item.name}`}
            disabled={busy}
            onClick={() => onEdit(item)}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Delete ${item.name}`}
            className="text-danger"
            disabled={busy}
            onClick={() => onDelete(item)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </Card>
  );
}

/**
 * What a box selecting this set actually ends up with.
 *
 * The merge of two sets is the one thing about this feature that is not
 * visible from either half, so it is shown rather than left to be worked out.
 */
function Merged({ preview }: { preview: AgentBundlePreview }) {
  const skills = preview.items.filter((i) => i.kind === 'skill');
  const commands = preview.items.filter((i) => i.kind === 'command');
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-medium">What a box using this set gets</h2>
      <p className="text-xs text-muted-foreground">
        The global set with this one laid over it — which is what is actually installed.
      </p>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-xs text-muted-foreground">AGENTS.md</dt>
        <dd className="text-xs">
          {preview.agentsMd === ''
            ? 'none'
            : `${preview.agentsMd.split('\n').length} lines, global first`}
        </dd>
        <dt className="text-xs text-muted-foreground">Skills</dt>
        <dd className="font-mono text-xs break-words">
          {skills.length === 0 ? 'none' : skills.map((i) => i.name).join(', ')}
        </dd>
        <dt className="text-xs text-muted-foreground">Commands</dt>
        <dd className="font-mono text-xs break-words">
          {commands.length === 0 ? 'none' : commands.map((i) => `/${i.name}`).join(', ')}
        </dd>
      </dl>
    </Card>
  );
}

/**
 * The editor for one skill or command.
 *
 * A name is fixed once the item exists: it is the skill's directory and the
 * word after the slash, and renaming in place would silently leave the old one
 * installed in every box until its next start. Delete and add is the honest
 * way to rename, and it is one more tap.
 */
function ItemDialog({
  kind,
  item,
  busy,
  onCancel,
  onSave,
}: {
  kind: AgentItemKind;
  item: AgentItem | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: { kind: AgentItemKind; name: string; content: string }) => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [content, setContent] = useState(item?.content ?? '');

  const skill = kind === 'skill';
  // A skill without front matter loads as nothing at all, and the failure is
  // silent inside the box, so it is called out here instead.
  const missingFrontMatter = skill && content.trim() !== '' && !content.startsWith('---');

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {item ? `Edit ${skill ? 'skill' : 'command'} ${item.name}` : `New ${skill ? 'skill' : 'command'}`}
          </DialogTitle>
          <DialogDescription>
            {skill
              ? 'Installed as skills/<name>/SKILL.md.'
              : 'Installed as commands/<name>.md, and invoked as /<name>.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div className="flex flex-col gap-2">
            <Label htmlFor="item-name">Name</Label>
            <Input
              id="item-name"
              value={name}
              disabled={item !== null}
              maxLength={64}
              placeholder={skill ? 'review-go' : 'ship'}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {item
                ? 'A name is fixed once it exists. Delete it and add it again to rename it.'
                : 'Lowercase letters, digits and dashes.'}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="item-content">{skill ? 'SKILL.md' : 'Prompt'}</Label>
            <Textarea
              id="item-content"
              value={content}
              className="min-h-64 font-mono text-xs"
              placeholder={
                skill
                  ? '---\nname: review-go\ndescription: Review Go code against the house style.\n---\n\nRead the diff and…\n'
                  : 'Open a pull request for the current branch, using the template in .github/.\n'
              }
              onChange={(e) => setContent(e.target.value)}
            />
            {missingFrontMatter ? (
              <p className="text-xs text-warn">
                A SKILL.md without <code className="font-mono">---</code> front matter naming the
                skill and describing it is not loaded at all.
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || name.trim() === ''}
            onClick={() => onSave({ kind, name: name.trim(), content })}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
