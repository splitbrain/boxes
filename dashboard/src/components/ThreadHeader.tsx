import { ArrowLeft, FileSearch, GitBranch, Info, SlidersHorizontal } from 'lucide-react';
import { Link } from 'react-router';
import type { SessionConfigOption, SessionModeState } from '../stores/thread/acp-types.ts';
import type { ConnectionState } from '../stores/thread/acp-client.ts';
import type { Up } from '@/hooks/use-up';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** What the connection dot says, and the colour it says it in. */
const CONNECTION: Record<ConnectionState, { label: string; dot: string }> = {
  connecting: { label: 'connecting', dot: 'bg-warn animate-pulse' },
  ready: { label: 'connected', dot: 'bg-ok' },
  reconnecting: { label: 'reconnecting', dot: 'bg-warn animate-pulse' },
  closed: { label: 'disconnected', dot: 'bg-idle' },
};

/**
 * Whether an option is one this header can put a control on.
 *
 * A select with something to choose between. The adapter may advertise other
 * kinds — it has a boolean form of some options for clients that ask for one,
 * which this one does not — and an option with a single value is not a
 * choice.
 */
function isSelectable(option: SessionConfigOption): boolean {
  return (option.type ?? 'select') === 'select' && (option.options?.length ?? 0) > 1;
}

/** One config option as a native select. */
function ConfigSelect({
  option,
  label,
  className,
  onSet,
}: {
  option: SessionConfigOption;
  /** What to call it. The adapter's own name, unless the header has a better one. */
  label?: string;
  className?: string;
  onSet: (value: string) => void;
}) {
  const name = label ?? option.name;
  const current = option.options?.find((value) => value.value === option.currentValue);
  return (
    <select
      aria-label={name}
      value={option.currentValue ?? ''}
      onChange={(event) => onSet(event.target.value)}
      title={current?.description ?? current?.name ?? option.description ?? name}
      className={cn('min-w-0 rounded-md border bg-muted px-2 py-1 text-xs', className)}
    >
      {option.options?.map((value) => (
        <option key={value.value} value={value.value}>
          {value.name}
        </option>
      ))}
    </select>
  );
}

/**
 * One setting in the overlay: what it is called, what it does, and the
 * control. A label rather than a heading and a control, so the whole block is
 * the hit area — these are read and set with a thumb.
 */
function Setting({
  name,
  description,
  children,
}: {
  name: string;
  /** What the adapter says it does, when it says anything. */
  description?: string | null | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium">{name}</span>
      {description ? <span className="text-muted-foreground">{description}</span> : null}
      {children}
    </label>
  );
}

/**
 * The thread's own chrome: where it goes back to, which of the session's
 * conversations it is, what it is connected to, how to branch it — and one
 * button holding everything the adapter lets a client set.
 */
export function ThreadHeader({
  sessionId,
  threadId,
  up,
  name,
  threadLabel,
  connection,
  modes,
  configOptions,
  canFork,
  forking,
  onFork,
  onSetMode,
  onSetConfigOption,
}: {
  sessionId: string;
  /** Which thread this is, so the info view can come back to it exactly. */
  threadId: string | null;
  /** The way out, which pops the thread rather than pushing the list. */
  up: Up;
  name: string;
  /** Which conversation of the session this is, or null while it is unknown. */
  threadLabel: string | null;
  connection: ConnectionState;
  modes: SessionModeState | null;
  configOptions: readonly SessionConfigOption[];
  /** Whether the adapter advertised the fork capability; see SessionSummary. */
  canFork: boolean;
  /** Held while a fork is in flight, so a double tap cannot branch twice. */
  forking: boolean;
  onFork: () => void;
  onSetMode: (modeId: string) => void;
  onSetConfigOption: (configId: string, value: string) => void;
}) {
  const state = CONNECTION[connection];
  const current = modes?.availableModes.find((mode) => mode.id === modes.currentModeId);
  // By category rather than by id: what the option is for is part of the
  // protocol, the id the adapter gives it is not.
  const model = configOptions.find((option) => option.category === 'model');
  // Everything else the adapter lets a client set — the effort level, fast
  // mode, the agent persona, whatever a later adapter adds.
  //
  // The mode is excluded because `modes` is already it, under the adapter's
  // other name for the same thing: a client that reads both would offer the
  // permission mode twice and have to keep the two in step.
  const rest = configOptions.filter(
    (option) =>
      option !== model && option.category !== 'mode' && isSelectable(option),
  );

  // Everything the adapter offers now lives behind the one button, the mode
  // and the model included. Four controls and a name do not fit a phone's
  // header — the name was down to a couple of words with the selects beside
  // it — and a setting is a thing you glance at rarely and change rarer
  // still. The button is beside the name, so any of them is two taps away.
  const hasModes = Boolean(modes && modes.availableModes.length > 1);
  const hasModel = Boolean(model && isSelectable(model));
  const settings = hasModes || hasModel || rest.length > 0;

  return (
    <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      {/* Leaving pops the thread's own entries; it does not push the list on
          top of them. Anything else and this button and the device's back
          button point the same way, which is what made back unpredictable. */}
      <Button asChild variant="ghost" size="sm" className="shrink-0 px-2">
        <a href={up.href} onClick={up.onClick} aria-label="Back to sessions">
          <ArrowLeft className="size-4" />
        </a>
      </Button>

      {/* A floor under the name, which the icon buttons cannot push past. */}
      <div className="flex min-w-16 flex-1 flex-col">
        {/* The thread's name shares the session's line: the row below is the
            connection state. */}
        <span className="flex items-baseline gap-1.5 text-sm">
          {/* The session's name goes first and keeps up to two thirds of the
              line: which box you are in matters more than which of its
              conversations, so the thread's name is what gives way. */}
          <span className="max-w-2/3 shrink-0 truncate font-medium">{name}</span>
          {threadLabel ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{threadLabel}</span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', state.dot)} />
          {state.label}
        </span>
      </div>

      {/* Whatever the adapter advertises, with nothing hardcoded: an adapter
          that offers no modes, no model and nothing else gets no button.

          Selects rather than rows of buttons: six modes are longer than a
          phone is wide, and the native control opens the platform's own
          picker and brings its keyboard and screen-reader behaviour with
          it. */}
      {settings ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label="Agent settings"
              title="Mode, model, effort and the adapter's other settings"
            >
              <SlidersHorizontal />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <div className="flex flex-col gap-3">
              {/* The mode first: of everything here it is the one that gets
                  changed mid-thread, when a plan turns into work. */}
              {modes && hasModes ? (
                <Setting name="Agent mode" description={current?.description}>
                  <select
                    aria-label="Agent mode"
                    value={modes.currentModeId}
                    onChange={(event) => onSetMode(event.target.value)}
                    className="mt-0.5 min-w-0 rounded-md border bg-muted px-2 py-1.5 text-xs"
                  >
                    {modes.availableModes.map((mode) => (
                      <option key={mode.id} value={mode.id}>
                        {mode.name}
                      </option>
                    ))}
                  </select>
                </Setting>
              ) : null}

              {model && hasModel ? (
                <Setting name={model.name} description={model.description}>
                  <ConfigSelect
                    option={model}
                    label="Model"
                    className="mt-0.5 py-1.5"
                    onSet={(value) => onSetConfigOption(model.id, value)}
                  />
                </Setting>
              ) : null}

              {rest.map((option) => (
                <Setting key={option.id} name={option.name} description={option.description}>
                  <ConfigSelect
                    option={option}
                    className="mt-0.5 py-1.5"
                    onSet={(value) => onSetConfigOption(option.id, value)}
                  />
                </Setting>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}

      {/* Branching belongs here rather than only on the list, because this is
          where the motion starts: you are in a thread that is doing something
          long, and you want a second one to ask about it. The fork keeps
          running alongside this thread rather than replacing it. */}
      {canFork ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          disabled={forking}
          onClick={onFork}
          aria-label="Fork this thread"
          title="Fork this thread into a second one"
        >
          <GitBranch />
        </Button>
      ) : null}

      {/* Reviewing sits next to forking because it is the other thing you do
          from inside a thread when the agent has produced something: read what
          it wrote, comment on it, and hand the comments back. */}
      <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
        <Link
          to={`/sessions/${sessionId}/review`}
          // Which conversation the review was opened from, so its back link
          // and its handoff come back here rather than to whichever thread the
          // session has current — the two differ as soon as one is forked.
          state={{ threadId }}
          aria-label="Review this session's code"
          title="Review this session's code"
        >
          <FileSearch />
        </Link>
      </Button>

      <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
        <Link
          to={`/sessions/${sessionId}/info`}
          state={{ threadId }}
          aria-label="Session details and controls"
        >
          <Info />
        </Link>
      </Button>
    </header>
  );
}
