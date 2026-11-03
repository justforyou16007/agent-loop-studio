import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Text of a definition or a role file. A role named in backticks becomes a
 * chip that opens it; links leave only to http(s).
 */
export function Markdown({
  text,
  roles,
  onRole,
}: {
  text: string;
  roles?: Set<string>;
  onRole?: (name: string) => void;
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
