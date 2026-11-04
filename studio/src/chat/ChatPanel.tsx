import {
  ArrowRight,
  ArrowUp,
  AtSign,
  Box,
  Check,
  Eye,
  LayoutPanelLeft,
  Loader2,
  PencilLine,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Candidate } from "../../../src/tools/studio-types.js";
import { useLang } from "../i18n.js";
import { Markdown } from "../Markdown.js";
import type { LoopRef } from "../PreviewDialog.js";
import type { ChatMessage, Pointable, Reference } from "../types.js";
import { Badge, Button, cx, LoopBadges } from "../ui.js";

/** The @ being typed just before the caret, and what follows it so far; none inside a word, such as an e-mail address. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  const query = before.slice(start + 1);
  if (/\s/.test(query) || query.length > 40) return null;
  if (start > 0 && /[A-Za-z0-9._%+-]/.test(before[start - 1]!)) return null;
  return { start, query };
}
const squeeze = (text: string): string => text.toLowerCase().replace(/\s+/g, "");
const KIND_ICONS = { node: Box, edge: ArrowRight, param: SlidersHorizontal } as const;

export function ChatPanel({
  messages,
  references,
  pointables,
  busy,
  onSend,
  onReference,
  onRemoveReference,
  onPreview,
  onOpen,
  current,
  mode,
  onMode,
  canChange,
  waiting,
  target,
  onClearTarget,
  onViewFiles,
}: {
  messages: ChatMessage[];
  references: Reference[];
  /** What is on the canvas to point at, for the @ list. */
  pointables: Pointable[];
  busy: boolean;
  onSend: (text: string) => void;
  onReference: (reference: Reference) => void;
  onRemoveReference: (id: string) => void;
  onPreview: (target: LoopRef) => void;
  onOpen: (target: LoopRef) => void;
  current: LoopRef | null;
  /** What a message does: change the loop on the canvas, or find loops. */
  mode: "change" | "find";
  onMode: (mode: "change" | "find") => void;
  canChange: boolean;
  /** A loop waits for the owner's reply. */
  waiting: boolean;
  /** What the chat changes instead of the loop on the canvas, such as a role. */
  target: string | null;
  onClearTarget: () => void;
  onViewFiles: (files: NonNullable<ChatMessage["files"]>) => void;
}) {
  const { t } = useLang();
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const options = useRef<HTMLUListElement>(null);
  /** The @ being typed, while its list is open. */
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  /** Where the @ whose list the owner closed with Esc is: it stays closed until another @ is typed. */
  const dismissed = useRef<number | null>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [messages]);
  useEffect(() => {
    if (references.length) box.current?.focus();
  }, [references.length]);
  const matches = useMemo(() => {
    if (!mention) return [];
    const query = squeeze(mention.query);
    return pointables.filter((item) =>
      squeeze(`${item.label} ${item.detail} ${t(`ref_${item.kind}`)}`).includes(query),
    );
  }, [mention, pointables, t]);
  const pointed = useMemo(() => new Set(references.map((entry) => entry.id)), [references]);
  useEffect(() => {
    options.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, mention]);

  /** Open, follow or close the @ list as the text and the caret move. */
  const follow = (text: string, caret: number) => {
    if (dismissed.current !== null && text[dismissed.current] !== "@") dismissed.current = null;
    const found = mentionAt(text, caret);
    setMention(found && found.start !== dismissed.current ? found : null);
    setActive(0);
  };
  /** The chosen item: pointed at, as a click on the canvas would, and named in the sentence in place of what was typed. */
  const choose = (item: Pointable) => {
    if (!mention) return;
    const named = `@${item.label} `;
    const end = mention.start + 1 + mention.query.length;
    const next = draft.slice(0, mention.start) + named + draft.slice(end);
    const caret = mention.start + named.length;
    setDraft(next);
    setMention(null);
    onReference({ kind: item.kind, id: item.id, label: item.label });
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(caret, caret);
    });
  };
  /** The @ button: an @ at the caret, which opens the list. */
  const startMention = () => {
    const field = box.current;
    const at = field?.selectionStart ?? draft.length;
    const end = field?.selectionEnd ?? at;
    const typed = at > 0 && /[A-Za-z0-9._%+-]/.test(draft[at - 1]!) ? " @" : "@";
    const next = draft.slice(0, at) + typed + draft.slice(end);
    const caret = at + typed.length;
    setDraft(next);
    dismissed.current = null;
    follow(next, caret);
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(caret, caret);
    });
  };

  const send = () => {
    const text = draft.trim();
    if ((!text && !references.length) || busy) return;
    onSend(text);
    setDraft("");
    setMention(null);
  };
  const onlyWelcome =
    messages.length <= 2 && messages.every((message) => message.from === "studio");

  return (
    <section className="flex h-full min-h-0 flex-col border-r border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Sparkles size={16} className="text-brand-600" />
        <h2 className="text-sm font-semibold">{t("chat")}</h2>
        <span className="text-xs text-ink-4">{t("chat_hint")}</span>
      </header>
      <div ref={list} className="scroll-thin flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            onPreview={onPreview}
            onOpen={onOpen}
            current={current}
            onReply={waiting && !busy ? onSend : undefined}
            onViewFiles={onViewFiles}
          />
        ))}
        {onlyWelcome && (
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">
              {t("examples")}
            </div>
            {(["example_1", "example_2", "example_3"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setDraft(t(key))}
                className="block w-full rounded-xl border border-line px-3 py-2 text-left text-[13px] leading-5 text-ink-2 hover:border-brand-500 hover:bg-brand-50"
              >
                {t(key)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-line p-3">
        {target && (
          <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-loop-50 px-2.5 py-1.5 text-[12px] text-loop-600">
            <PencilLine size={12} />
            <span className="flex-1 truncate font-medium">{target}</span>
            <button
              type="button"
              title={t("remove")}
              onClick={onClearTarget}
              className="rounded p-0.5 hover:bg-white"
            >
              <X size={12} />
            </button>
          </div>
        )}
        {canChange && (
          <div className="mb-2 inline-flex rounded-lg bg-canvas p-0.5 text-[12px]">
            {(
              [
                ["change", waiting ? "mode_reply" : "mode_change", PencilLine],
                ["find", "mode_find", Search],
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                onClick={() => onMode(key)}
                className={cx(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 font-medium",
                  mode === key ? "bg-white text-ink shadow-card" : "text-ink-3 hover:text-ink-2",
                )}
              >
                <Icon size={12} /> {t(label)}
              </button>
            ))}
          </div>
        )}
        <div className="relative rounded-xl border border-line-strong bg-white shadow-card focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100">
          {mention && (
            <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-line bg-panel shadow-float">
              {pointables.length === 0 || matches.length === 0 ? (
                <p className="px-3 py-2.5 text-xs text-ink-4">
                  {t(pointables.length === 0 ? "mention_empty" : "mention_none")}
                </p>
              ) : (
                <ul
                  ref={options}
                  role="listbox"
                  className="scroll-thin max-h-64 overflow-y-auto py-1"
                >
                  {matches.map((item, index) => {
                    const Icon = KIND_ICONS[item.kind];
                    return (
                      <li
                        key={item.id}
                        role="option"
                        aria-selected={index === active}
                        onMouseDown={(event) => {
                          // Chosen before the text box loses the caret.
                          event.preventDefault();
                          choose(item);
                        }}
                        onMouseEnter={() => setActive(index)}
                        className={cx(
                          "flex cursor-pointer items-center gap-2 px-3 py-1.5",
                          index === active ? "bg-brand-50" : "hover:bg-canvas",
                        )}
                      >
                        <Icon size={13} className="shrink-0 text-ink-4" />
                        <span className="min-w-0 flex-1">
                          <span
                            className={cx(
                              "block truncate text-[13px]",
                              index === active ? "text-brand-700" : "text-ink-2",
                            )}
                          >
                            {item.label}
                          </span>
                          {item.detail && (
                            <span className="block truncate text-[11px] text-ink-4">
                              {item.detail}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-4">
                          {t(`ref_${item.kind}`)}
                        </span>
                        {pointed.has(item.id) && (
                          <Check size={12} className="shrink-0 text-brand-600" />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="border-t border-line px-3 py-1 text-[11px] text-ink-4">
                {t("mention_hint")}
              </div>
            </div>
          )}
          {references.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2.5 pt-2.5">
              {references.map((reference) => (
                <span
                  key={reference.id}
                  className="inline-flex items-center gap-1 rounded-md bg-brand-50 py-0.5 pl-1.5 pr-1 text-[12px] text-brand-700"
                >
                  <AtSign size={11} />
                  {reference.label}
                  <button
                    type="button"
                    title={t("remove")}
                    onClick={() => onRemoveReference(reference.id)}
                    className="rounded p-0.5 hover:bg-brand-100"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={box}
            value={draft}
            rows={3}
            onChange={(event) => {
              setDraft(event.target.value);
              follow(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) =>
              follow(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)
            }
            onBlur={() => setMention(null)}
            onKeyDown={(event) => {
              // A Chinese input method's keys pick its own candidates: nothing here while it composes.
              if (event.nativeEvent.isComposing) return;
              if (mention) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  dismissed.current = mention.start;
                  setMention(null);
                  return;
                }
                if (matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
                  setActive((current) => (current + step) % matches.length);
                  return;
                }
                if (matches.length && (event.key === "Enter" || event.key === "Tab")) {
                  event.preventDefault();
                  choose(matches[Math.min(active, matches.length - 1)]!);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={t(
              mode === "find" || !canChange
                ? "composer"
                : waiting
                  ? "composer_reply"
                  : "composer_change",
            )}
            className="block w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-5 outline-none placeholder:text-ink-4"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={startMention}
              title={t("mention_button")}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-canvas hover:text-brand-600"
            >
              <AtSign size={16} />
            </button>
            <button
              type="button"
              onClick={send}
              disabled={busy || (!draft.trim() && !references.length)}
              title={t("send")}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white shadow-card hover:bg-brand-700 disabled:opacity-40"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Message({
  message,
  onPreview,
  onOpen,
  current,
  onReply,
  onViewFiles,
}: {
  message: ChatMessage;
  onPreview: (target: LoopRef) => void;
  onOpen: (target: LoopRef) => void;
  current: LoopRef | null;
  /** Answers the review this message shows, while it is the one waiting. */
  onReply?: (text: string) => void;
  onViewFiles: (files: NonNullable<ChatMessage["files"]>) => void;
}) {
  const { t } = useLang();
  if (message.from === "owner")
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-tr-md bg-brand-600 px-3.5 py-2 text-[13px] leading-5 text-white">
          {message.references?.length ? (
            <div className="mb-1 flex flex-wrap gap-1">
              {message.references.map((reference) => (
                <span key={reference.id} className="rounded bg-white/20 px-1 text-[11px]">
                  @{reference.label}
                </span>
              ))}
            </div>
          ) : null}
          {message.text}
        </div>
      </div>
    );
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        {message.pending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="whitespace-pre-wrap text-[13px] leading-5 text-ink-2">
          {message.key ? t(message.key, message.values) : message.text}
        </p>
        {message.progress && message.progress.length > 0 && (
          <ol className="space-y-1 rounded-xl border border-line bg-canvas/60 px-3 py-2">
            {message.progress.map((step, index) => (
              <li key={index} className="flex items-center gap-2 text-xs text-ink-2">
                {step.done ? (
                  <Check size={13} className="text-ok-600" />
                ) : (
                  <Loader2 size={13} className="animate-spin text-brand-600" />
                )}
                <span className="font-medium">{step.phase}</span>
                {step.role && <span className="font-mono text-[11px] text-ink-4">{step.role}</span>}
              </li>
            ))}
          </ol>
        )}
        {message.markdown && (
          <div className="scroll-thin max-h-[420px] overflow-y-auto rounded-xl border border-line bg-canvas/60 px-3 py-1">
            <Markdown text={message.markdown} />
          </div>
        )}
        {message.files && message.files.length > 0 && (
          <Button size="sm" onClick={() => onViewFiles(message.files!)}>
            <Eye size={13} /> {t("view_role_draft")}
          </Button>
        )}
        {message.actions && onReply && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="primary" onClick={() => onReply(t("approve_word"))}>
              <Check size={13} /> {t("approve")}
            </Button>
            <Button size="sm" onClick={() => onReply(t("cancel_word"))}>
              <X size={13} /> {t("cancel")}
            </Button>
            <span className="text-[11px] text-ink-4">{t("revise_hint")}</span>
          </div>
        )}
        {message.candidates?.map((candidate) => (
          <CandidateCard
            key={`${candidate.source}:${candidate.name}`}
            candidate={candidate}
            onPreview={onPreview}
            onOpen={onOpen}
            active={current?.name === candidate.name && current.source === candidate.source}
          />
        ))}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  onPreview,
  onOpen,
  active,
}: {
  candidate: Candidate;
  onPreview: (target: LoopRef) => void;
  onOpen: (target: LoopRef) => void;
  active: boolean;
}) {
  const { t } = useLang();
  const target = { name: candidate.name, source: candidate.source };
  return (
    <div
      className={cx(
        "rounded-xl border bg-white px-3 py-2.5 shadow-card",
        active ? "border-brand-500 ring-1 ring-brand-500" : "border-line",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[13px] font-semibold text-ink">{candidate.name}</span>
        <LoopBadges loop={candidate} compact />
      </div>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink-3">{candidate.description}</p>
      {candidate.matched.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-ink-4">{t("matched")}</span>
          {candidate.matched.slice(0, 8).map((word) => (
            <Badge key={word}>{word}</Badge>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" onClick={() => onPreview(target)}>
          <Eye size={13} /> {t("preview")}
        </Button>
        <Button
          size="sm"
          variant={active ? "secondary" : "primary"}
          disabled={active}
          onClick={() => onOpen(target)}
        >
          <LayoutPanelLeft size={13} /> {t("open")}
        </Button>
      </div>
    </div>
  );
}
