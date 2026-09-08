import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AgentSetSummary } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { refresh } from '../stores/sessions.ts';
import { Notice } from '@/components/Notice';
import { useUp } from '@/hooks/use-up';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** What the picker calls "no extra set", which the API treats as absent. */
const NO_SET = 'none';

/** The new-session form, which opens the session's thread on success. */
export function SessionCreate() {
  const navigate = useNavigate();
  /** Out to the session list, whether the form was cancelled or submitted. */
  const up = useUp('/');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The sets a box may be created with, which is every set but the global
   * one: that goes in either way, so offering it would only suggest it were
   * optional. Null while they are still loading, and an empty list where the
   * deployment has never made one — in both cases the picker stays out of the
   * way rather than showing a control with nothing in it.
   */
  const [agentSets, setAgentSets] = useState<AgentSetSummary[] | null>(null);
  const [agentSet, setAgentSet] = useState(NO_SET);

  useEffect(() => {
    void (async () => {
      try {
        setAgentSets((await api.listAgentSets()).filter((s) => !s.global));
      } catch {
        // A box can be created without one; the form does not need this to work.
        setAgentSets([]);
      }
    })();
  }, []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSession({
        name: name.trim(),
        agentSet: agentSet === NO_SET ? null : agentSet,
      });
      await refresh();
      // The form's entry is spent on the thread it made rather than left
      // under it: the box exists now, and back onto a form that would make a
      // second one is not where anybody meant to go.
      void navigate(`/sessions/${created.id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)}>
      <h1 className="text-xl font-semibold">New session</h1>

      <div className="flex flex-col gap-2">
        <Label htmlFor="session-name">Name</Label>
        <Input
          id="session-name"
          value={name}
          required
          maxLength={100}
          placeholder="refactor auth"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {agentSets && agentSets.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="session-agent-set">Agent set</Label>
          <Select value={agentSet} onValueChange={setAgentSet}>
            <SelectTrigger id="session-agent-set" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SET}>Global set only</SelectItem>
              {agentSets.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Merged over the global AGENTS.md, skills and commands, which every box gets.{' '}
            <Link to="/agents" className="underline hover:text-foreground">
              Edit the sets
            </Link>
            .
          </p>
        </div>
      ) : null}

      {error ? (
        <Notice className="rounded-md border px-3 py-2">{error}</Notice>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={up.go} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </form>
  );
}
