import { Workflow } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Text of a definition, a role file or a review note. A role or loop named in
 * backticks becomes a chip the reader can click: the caller says what it does
 * (open the role, or point it out on the canvas). Links leave only to http(s).
 */
export function Markdown({
  text,
  roles,
  onRole,
  loops,
  onLoop,
}: {
  text: string;
  roles?: Set<string>;
  onRole?: (name: string) => void;
  loops?: Set<string>;
  onLoop?: (name: string) => void;
}) {
  return (
    <div className="prose-studio text-[13px] leading-6 text-ink-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : "")}
        components={{
          code({ children, className }) {
            const value = String(children);
            if (!className && roles?.has(value) && onRole)
              return (
                <button
                  type="button"
                  onClick={() => onRole(value)}
                  className="rounded-md bg-brand-50 px-1 font-mono text-[12px] text-brand-700 hover:bg-brand-100"
                >
                  {value}
                </button>
              );
            if (!className && loops?.has(value) && onLoop)
              return (
                <button
                  type="button"
                  onClick={() => onLoop(value)}
                  className="inline-flex items-center gap-0.5 rounded-md bg-loop-50 px-1 font-mono text-[12px] text-loop-600 hover:ring-1 hover:ring-loop-600"
                >
                  <Workflow size={11} />
                  {value}
                </button>
              );
            return <code className={className}>{children}</code>;
          },
          a({ href, children }) {
            return href ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
