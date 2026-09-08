import { ChevronRight, Globe, Layers, Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AgentSetSummary } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { BackLink } from '@/components/BackLink';
import { useUp } from '@/hooks/use-up';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Every agent set, the global one first.
 *
 * A set is an AGENTS.md, some skills and some slash commands. The global one
 * is applied to every box; a box may name one more, and the two are merged.
 * That is the whole model, and the paragraph at the top of this page is where
 * it is explained, because nowhere else in the UI has room for it.
 */
export function AgentSets() {
  /** Out to the session list, popped rather than pushed; see useUp. */
  const up = useUp('/');
  const [sets, setSets] = useState<AgentSetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AgentSetSummary | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setSets(await api.listAgentSets());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createAgentSet(name.trim());
      setName('');
      setCreating(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (set: AgentSetSummary): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgentSet(set.id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <BackLink up={up} label="Sessions" />

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agent configuration</h1>
        <Button size="sm" onClick={() => setCreating((c) => !c)}>
          <Plus />
          New set
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        A set is an <code className="font-mono">AGENTS.md</code>, some skills and some slash
        commands. The global set goes into every box. A box can name one more set when it is
        created, and the two are merged: the AGENTS.md files are concatenated, and a skill or
        command in the named set replaces the global one of the same name.
      </p>

      {creating ? (
        <Card className="p-4">
          <form className="flex flex-col gap-3" onSubmit={(e) => void create(e)}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="set-name">Name of the new set</Label>
              <Input
                id="set-name"
                value={name}
                autoFocus
                required
                maxLength={100}
                placeholder="Go projects"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {error ? (
        <Notice className="rounded-md border px-3 py-2">{error}</Notice>
      ) : null}

      {sets === null ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
      ) : null}

      {sets?.map((set) => (
        <Card key={set.id} className="flex flex-row items-center gap-3 p-4">
          <Link to={`/agents/${set.id}`} className="flex min-w-0 flex-1 items-center gap-3">
            {set.global ? (
              <Globe className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Layers className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{set.name}</span>
              <span className="text-xs text-muted-foreground">{describe(set)}</span>
            </span>
            <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </Link>
          {/* The global set has no delete: it is what every box gets, and a
              deployment without one would have nowhere to put a rule that
              always applies. */}
          {set.global ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-danger"
              onClick={() => setConfirmDelete(set)}
            >
              Delete
            </Button>
          )}
        </Card>
      ))}

      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete ${confirmDelete.name}?`}
          description={
            confirmDelete.sessionCount === 0
              ? 'The set and everything in it is removed. Boxes are unaffected.'
              : `${confirmDelete.sessionCount} existing ${
                  confirmDelete.sessionCount === 1 ? 'box was' : 'boxes were'
                } created with this set. They keep running and keep what is already installed in them, but fall back to the global set alone the next time they start.`
          }
          confirmLabel="Delete"
          danger
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void remove(confirmDelete)}
        />
      ) : null}
    </div>
  );
}

/** The one-line summary under a set's name. */
function describe(set: AgentSetSummary): string {
  const parts: string[] = [];
  if (set.hasAgentsMd) parts.push('AGENTS.md');
  if (set.skillCount > 0) {
    parts.push(`${set.skillCount} ${set.skillCount === 1 ? 'skill' : 'skills'}`);
  }
  if (set.commandCount > 0) {
    parts.push(`${set.commandCount} ${set.commandCount === 1 ? 'command' : 'commands'}`);
  }
  if (parts.length === 0) parts.push('empty');
  if (set.global) return `${parts.join(' · ')} — applied to every box`;
  if (set.sessionCount > 0) {
    parts.push(`${set.sessionCount} ${set.sessionCount === 1 ? 'box' : 'boxes'}`);
  }
  return parts.join(' · ');
}
