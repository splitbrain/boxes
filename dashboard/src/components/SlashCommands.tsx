import {
  ComposerPrimitive,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
  type Unstable_TriggerMatcher,
} from '@assistant-ui/react';
import { createContext, useContext, useMemo, type FC, type ReactNode } from 'react';
import type { AvailableCommand } from '../stores/thread/acp-types.ts';

/**
 * Completion for the slash commands the adapter advertises.
 *
 * The commands come from the thread's session/update stream, so what the
 * composer offers is what this agent accepts, and it changes with the agent
 * rather than with this build.
 */

/** The commands the composer completes, published by the thread route. */
const CommandsContext = createContext<AvailableCommand[]>([]);

/** Puts the adapter's command list where the composer can read it. */
export function SlashCommandsProvider({
  commands,
  children,
}: {
  commands: AvailableCommand[];
  children: ReactNode;
}) {
  return <CommandsContext.Provider value={commands}>{children}</CommandsContext.Provider>;
}

/**
 * Matches only a slash the prompt starts with.
 *
 * A slash command is the whole instruction or none of it, so a slash further
 * in is part of a path and must not open the list.
 */
const atStartOfPrompt: Unstable_TriggerMatcher = (text, char, cursorPosition) => {
  if (!text.startsWith(char)) return null;
  const nameEnd = text.indexOf(' ');
  if (nameEnd !== -1 && cursorPosition > nameEnd) return null;
  return { query: text.slice(char.length, cursorPosition), offset: 0, endOffset: cursorPosition };
};

/**
 * Writes the picked command back as the line it was typed as, which is what
 * the agent reads. Nothing here parses one out of the composer again, so the
 * parse half hands the text back whole.
 */
const asTypedCommand: Unstable_DirectiveFormatter = {
  serialize: (item) => `/${item.id}`,
  parse: (text) => [{ kind: 'text', text }],
};

/**
 * The command list as a trigger adapter.
 *
 * It offers no categories, and with none the popover searches from the
 * first keystroke: a bare slash lists every command and each further
 * character narrows it. Only the name is matched — a description here is a
 * paragraph, and matching one would answer with commands that look unrelated.
 */
function commandAdapter(commands: AvailableCommand[]) {
  const items: Unstable_TriggerItem[] = commands.map((command) => ({
    id: command.name,
    type: 'command',
    label: command.name,
    ...(command.description ? { description: command.description } : {}),
  }));
  return {
    categories: () => [],
    categoryItems: () => [],
    search: (query: string) => {
      const lower = query.toLowerCase();
      const named = items.filter((item) => item.id.toLowerCase().includes(lower));
      // What was typed reads as the start of a name, so those come first.
      return [
        ...named.filter((item) => item.id.toLowerCase().startsWith(lower)),
        ...named.filter((item) => !item.id.toLowerCase().startsWith(lower)),
      ];
    },
  };
}

/**
 * The completion list itself, rendered above the composer while a slash
 * command is being typed.
 *
 * Picking one writes its name into the composer rather than sending it: a
 * command often takes arguments, and running it is the agent's job.
 */
export const SlashCommands: FC = () => {
  const commands = useContext(CommandsContext);
  const adapter = useMemo(() => commandAdapter(commands), [commands]);
  if (commands.length === 0) return null;

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      matcher={atStartOfPrompt}
      adapter={adapter}
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-64 overflow-y-auto overscroll-contain rounded-xl border bg-popover p-1 shadow-lg"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={asTypedCommand} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) =>
          items.map((item, index) => (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              key={item.id}
              item={item}
              index={index}
              className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left data-[highlighted]:bg-accent"
            >
              {/* Both lines break anywhere they have to: a description is
                  whatever the agent wrote, and one long unbroken word in one
                  of them would otherwise widen the popover past a phone and
                  leave the whole list scrolling sideways. */}
              <span className="w-full font-mono text-sm break-words">/{item.id}</span>
              {item.description ? (
                <span className="line-clamp-2 w-full text-xs break-words text-muted-foreground">
                  {item.description}
                </span>
              ) : null}
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
};
