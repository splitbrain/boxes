"use client";

import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/elements/attachment.aui";
import { File } from "@/components/assistant-ui/elements/file";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui";
import { Image } from "@/components/assistant-ui/elements/image";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { SlashCommands } from "@/components/SlashCommands";
import { Spinner } from "@/components/Spinner";
import { TaskNotificationPart } from "@/components/TaskNotification";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useFollowOutput } from "@/hooks/use-follow-output";
import { TASK_NOTIFICATION_PART } from "@/lib/task-notifications";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type ToolCallMessagePartComponent,
  unstable_useComposerInputHistory,
  useAui,
  useAuiEvent,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MicIcon,
  MoreHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ComponentType,
  type FC,
  type KeyboardEvent,
  type PropsWithChildren,
  type ReactNode,
} from "react";

/** A group of message parts, such as a tool group or a reasoning group. */
export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections. The other slots change how the assistant
 * message renders tool calls and part groups. A tool UI that is registered by
 * name wins over `ToolFallback`.
 */
export type ThreadComponents = {
  /** Replaces the whole assistant message. */
  AssistantMessage?: ComponentType | undefined;
  /** Replaces the welcome section of an empty thread. */
  Welcome?: ComponentType | undefined;
  /** Renders a tool call that has no registered tool UI. */
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  /** Renders a group of tool calls. */
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  /** Renders a group of reasoning parts. */
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};

/** The props of {@link Thread}. */
export type ThreadProps = {
  /** The component overrides. */
  components?: ThreadComponents | undefined;
  /** True to focus the composer on mount. */
  autoFocus?: boolean | undefined;
  /**
   * Boxes edit: content shown directly above the composer, such as the work
   * the thread has left running in the background.
   */
  aboveComposer?: ReactNode | undefined;
  /**
   * Boxes edit: content shown above the first message, such as the button
   * that loads the older messages of a cut thread.
   */
  aboveMessages?: ReactNode | undefined;
  /**
   * Boxes edit: the prompt that the agent expects the user to send next. The
   * composer offers it in an empty draft.
   */
  promptSuggestion?: string | null | undefined;
};

/** The overrides when the caller gives none. */
const EMPTY_COMPONENTS: ThreadComponents = {};

/** The component overrides of the thread, for the components below it. */
const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

/**
 * Checks if the thread shows as a new chat, with the composer in the centre.
 *
 * At startup the runtime shows a loading placeholder thread, which counts as a
 * new chat. A load after startup keeps the docked layout.
 *
 * @param s The assistant state.
 * @returns True when the thread has no messages and is not loading after startup.
 */
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

/**
 * Checks if a switched thread still fetches its history. The thread then shows
 * a skeleton and no welcome.
 *
 * @param s The assistant state.
 * @returns True while the history of a switched thread loads.
 */
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

/** Pulsing placeholder messages while the history of a thread loads. */
const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms]"
  >
    <span className="sr-only">Loading conversation</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

/**
 * The chat thread, with the transcript and the composer.
 *
 * @param components The component overrides.
 * @param autoFocus True to focus the composer on mount.
 * @param aboveComposer Boxes edit: content shown directly above the composer.
 * @param aboveMessages Boxes edit: content shown above the first message.
 * @param promptSuggestion Boxes edit: the prompt that the agent expects next.
 */
export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  aboveComposer,
  aboveMessages,
  promptSuggestion,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot
        isEmpty={isEmpty}
        autoFocus={autoFocus}
        aboveComposer={aboveComposer}
        aboveMessages={aboveMessages}
        promptSuggestion={promptSuggestion ?? null}
      />
    </ThreadComponentsContext.Provider>
  );
};

/**
 * The scrolling viewport of the thread, its messages and the composer footer.
 *
 * @param isEmpty True while the thread shows as a new chat.
 * @param autoFocus True to focus the composer on mount.
 * @param aboveComposer Content shown directly above the composer.
 * @param aboveMessages Content shown above the first message.
 * @param promptSuggestion The prompt that the agent expects next, or null.
 */
const ThreadRoot: FC<{
  /** True while the thread shows as a new chat. */
  isEmpty: boolean;
  /** True to focus the composer on mount. */
  autoFocus: boolean;
  /** Content shown directly above the composer. */
  aboveComposer?: ReactNode | undefined;
  /** Content shown above the first message. */
  aboveMessages?: ReactNode | undefined;
  /** The prompt that the agent expects next, or null. */
  promptSuggestion: string | null;
}> = ({ isEmpty, autoFocus, aboveComposer, aboveMessages, promptSuggestion }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  // Boxes edit: keeps the newest output in view once a turn outgrows the
  // screen. The turn anchor alone holds the prompt at the top and follows nothing.
  const viewport = useFollowOutput();

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-bg" as string]: "var(--color-card)",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      {/* Boxes edit: autoScroll with turnAnchor. A turn anchors its user
          message to the top. Other content that grows the thread without an
          anchor follows the bottom.

          Boxes edit: @container here as well, because a full-bleed block must
          fit the width of this element. The width of the root includes the
          vertical scrollbar of this element, so a bleed measured against the
          root overflows. */}
      <ThreadPrimitive.Viewport
        ref={viewport}
        autoScroll
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="@container relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>
          {aboveMessages}

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              /* Boxes edit: z-10, so the footer covers a hovered message.
                 The stylesheet raises a message that ends in rows on hover,
                 and without a z-index the footer paints under it. */
              !isEmpty &&
                "sticky bottom-0 z-10 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <ThreadFollowupSuggestions />
            {/* Boxes edit: the last thing read before typing. */}
            {aboveComposer}
            <Composer autoFocus={autoFocus} suggestion={promptSuggestion} />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

/**
 * The stock tool group. Boxes edit: it opens itself when a call inside it
 * waits on the user.
 *
 * The adapter blocks on a permission request until it is answered, so a
 * folded question would stall the turn. Only the interrupt reason opens
 * the group. The other requires-action reason is a call that waits for its own
 * result, which needs nothing from the user.
 *
 * @param group The group part, with its status and the indices of its calls.
 * @param children The tool calls.
 */
const DefaultToolGroup: FC<PropsWithChildren<{ group: ThreadGroupPart }>> = ({
  group,
  children,
}) => {
  const running = group.status.type === "running";
  const waiting =
    group.status.type === "requires-action" && group.status.reason === "interrupt";

  const [open, setOpen] = useState(waiting);
  const [wasWaiting, setWasWaiting] = useState(waiting);
  if (waiting !== wasWaiting) {
    setWasWaiting(waiting);
    if (waiting) setOpen(true);
  }

  return (
    <ToolGroupRoot variant="ghost" open={open} onOpenChange={setOpen}>
      <ToolGroupTrigger count={group.indices.length} active={running} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

/** Boxes edit: the renderers for the data parts Boxes adds, by part name. */
const DATA_PARTS = {
  by_name: { [TASK_NOTIFICATION_PART]: TaskNotificationPart },
};

/**
 * Boxes edit: checks if a message holds only background-task notifications.
 *
 * The harness wakes the agent with a user-role message when a task reports in,
 * so such a message arrives as a user message. The thread draws it as a small,
 * muted row and not as a user bubble.
 *
 * @param s The assistant state of the message.
 * @returns True when every part of the message is a task notification.
 */
const isTaskNotification = (s: AssistantState) =>
  s.message.content.length > 0 &&
  s.message.content.every(
    (part) => part.type === "data" && part.name === TASK_NOTIFICATION_PART,
  );

/** One message, rendered by its role. Boxes edit: task notifications get their own row. */
const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  const isTask = useAuiState(isTaskNotification);

  if (isEditing) return <EditComposer />;
  if (role === "user")
    return isTask ? <TaskNotificationMessage /> : <UserMessage />;
  return <AssistantMessageComponent />;
};

/** The round button that scrolls the thread to its end. It hides at the end. */
const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

/** The greeting of an empty thread. */
const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
        How can I help you today?
      </h1>
    </div>
  );
};

/** The suggested first prompts of an empty thread. */
const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

/** One suggested first prompt. A click sends it. */
const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <Button
          variant="ghost"
          className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors"
        >
          <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
          <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
        </Button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

/**
 * The message composer, with attachments and the slash-command list.
 *
 * @param autoFocus True to focus the input on mount.
 * @param suggestion The prompt that the agent expects next, or null.
 */
const Composer: FC<{
  /** True to focus the input on mount. */
  autoFocus: boolean;
  /** Boxes edit: the prompt that the agent expects next, or null. */
  suggestion: string | null;
}> = ({ autoFocus, suggestion }) => {
  // Boxes edit: ArrowUp on an empty draft walks back through sent messages,
  // and ArrowDown returns to the draft.
  const history = unstable_useComposerInputHistory();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const aui = useAui();

  // Boxes edit: the agent's predicted next prompt shows as the placeholder of
  // an empty draft, and Tab takes it into the draft without sending it.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    history.onKeyDown(e);
    if (e.defaultPrevented || e.key !== "Tab" || !suggestion) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
    if (e.currentTarget.value !== "") return;
    e.preventDefault();
    aui.composer.setText(suggestion);
  };

  // Boxes edit: keeps the caret in the composer after a send, so the next
  // prompt needs no tap.
  useAuiEvent({ event: "composer.send", scope: "thread" }, () => {
    // Waits for the runtime to clear the draft, so the re-render that follows
    // does not take the focus away again.
    requestAnimationFrame(() => inputRef.current?.focus());
  });

  return (
    // Boxes edit: the trigger root wraps the composer, so the keyboard handling
    // of the input drives the slash-command list. The list sits inside the
    // relatively positioned root it opens above.
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
        <SlashCommands />
        <ComposerPrimitive.AttachmentDropzone asChild>
          <div
            data-slot="aui_composer-shell"
            className="border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
          >
            <ComposerAttachments />
            <ComposerPrimitive.Input
              ref={inputRef}
              placeholder={suggestion ? `${suggestion}  (Tab)` : "Send a message..."}
              className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
              rows={1}
              autoFocus={autoFocus}
              // Boxes edit: a prompt is often several lines of prose, so Enter
              // adds a line and Ctrl/Cmd+Enter sends. On touch, the send
              // button sends.
              submitMode="ctrlEnter"
              enterKeyHint="enter"
              aria-label="Message input"
              onKeyDown={onKeyDown}
            />
            <ComposerAction />
          </div>
        </ComposerPrimitive.AttachmentDropzone>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

/** The buttons below the composer input: attach, dictate, and send or stop. */
const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      {/* Boxes edit: a file picked here is uploaded into the workspace of the
          box, so it can be of any type. */}
      <ComposerAddAttachment />
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="Stop voice input"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip="Send message"
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              aria-label="Send message"
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-7 rounded-full"
              aria-label="Stop generating"
            >
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

/** The error of a failed assistant message. */
const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

/** One assistant message: its grouped parts, any error, and the action bar. */
const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
  } = useContext(ThreadComponentsContext);

  const ACTION_BAR_PT = "pt-1.5";
  // Reserves the height of the action bar below the message. The negative
  // margin of the root cancels the reservation in the flow, so the next message
  // keeps its place.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      /* Boxes edit: no content-visibility utilities here, unlike the user
         message. Their paint containment would clip a table or code block
         that bleeds out of the reading column, so the stylesheet applies them
         only to messages without such a block. */
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return <DefaultToolGroup group={part}>{children}</DefaultToolGroup>;
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  /* Boxes edit: the ghost variant, like DefaultToolGroup, so
                     reasoning gets no framed box. */
                  <ReasoningRoot variant="ghost" streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <File {...part} />
                  </div>
                );
              case "image":
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              case "indicator":
                /* Boxes edit: uses the spinner of the dashboard. It is often the
                   only thing on screen while a turn thinks, and a pulsing dot
                   looks like a page that stopped repainting. */
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="inline-flex items-center py-1"
                  >
                    <Spinner label="Assistant is working" />
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

/** The copy and more actions under an assistant message. */
const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      {/* Boxes edit: no Reload button, because ACP cannot re-run a turn. */}
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

/**
 * Boxes edit: an attached file as a link to the endpoint that serves it from
 * the workspace of the box. The browser shows some types, such as PDF, and
 * downloads the rest. A file without an endpoint URL shows without a link.
 *
 * @param part The file part.
 */
const UserFilePart: FileMessagePartComponent = (part) => {
  const href = part.data.startsWith('/api/') ? part.data : null;
  const chip = <File {...part} />;
  return (
    <div data-slot="aui_user-message-file" className="py-1">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${part.filename ?? 'attachment'}`}
          className="inline-block rounded-lg"
        >
          {chip}
        </a>
      ) : (
        chip
      )}
    </div>
  );
};

/**
 * An image attached to a user message.
 *
 * @param part The image part.
 */
const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

/** One user message: its attachments, its text bubble and the branch picker. */
const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts
            components={{
              File: UserFilePart,
              Image: UserImagePart,
              // Boxes edit: renders a task notification that shares its
              // message with user text. A message of notifications alone
              // renders as TaskNotificationMessage.
              data: DATA_PARTS,
            }}
          />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 row-start-3 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  );
};

/**
 * Boxes edit: a message of background-task notifications, drawn as a small,
 * muted row at full width. It has no bubble, branch picker or actions, because nobody
 * wrote it.
 */
const TaskNotificationMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_task-notification-message-root"
      data-role="task-notification"
      className="fade-in slide-in-from-bottom-1 animate-in px-2 duration-150"
    >
      <MessagePrimitive.Parts components={{ data: DATA_PARTS }} />
    </MessagePrimitive.Root>
  );
};

/**
 * The composer for editing a sent message.
 *
 * Boxes edit: nothing opens it, because ACP cannot branch a conversation, and
 * a user message has no action bar with an Edit button. The component stays,
 * so the diff against a new registry version stays small.
 */
const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg)">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-3.5"
            >
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 rounded-full px-3.5">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

/**
 * The previous and next buttons between the branches of a message. It hides
 * for a message with one branch.
 *
 * @param className Extra classes.
 * @param rest The other props of the branch picker root.
 */
const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
