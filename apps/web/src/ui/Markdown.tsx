// Renders @govhub/forum's safe markdown tree as React elements. No HTML strings, no dangerouslySetInnerHTML:
// every string is a text node. Links open in a new tab without referrer or opener, marked as user content;
// images are links to the image (never loaded).
import { useMemo, type ReactNode } from 'react';
import { parseMarkdown, parsePlain, type MdBlock, type MdInline } from '@govhub/forum';
import { urlHost } from '../lib/format.ts';

function Inline({ nodes }: { nodes: MdInline[] }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'strong':
        return (
          <strong key={i}>
            <Inline nodes={n.c} />
          </strong>
        );
      case 'em':
        return (
          <em key={i}>
            <Inline nodes={n.c} />
          </em>
        );
      case 'del':
        return (
          <del key={i}>
            <Inline nodes={n.c} />
          </del>
        );
      case 'code':
        return <code key={i}>{n.v}</code>;
      case 'br':
        return <br key={i} />;
      case 'link':
        return n.href ? (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow ugc" className="md-link" title={n.href}>
            <Inline nodes={n.c} />
          </a>
        ) : (
          <span key={i} className="md-badlink" title="link removed: only http(s) links are allowed">
            <Inline nodes={n.c} />
          </span>
        );
      case 'image':
        return n.href ? (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow ugc" className="md-image" title={`image not loaded: ${n.href}`}>
            [image{n.alt ? `: ${n.alt}` : ''}, {urlHost(n.href)}]
          </a>
        ) : (
          <span key={i} className="md-badlink">
            [image{n.alt ? `: ${n.alt}` : ''}]
          </span>
        );
    }
  });
}

function Blocks({ nodes }: { nodes: MdBlock[] }): ReactNode {
  return nodes.map((b, i) => {
    switch (b.t) {
      case 'p':
        return (
          <p key={i}>
            <Inline nodes={b.c} />
          </p>
        );
      case 'h':
        // Headings inside user content are styled text, not document headings (they must not break the page outline).
        return (
          <p key={i} className={`md-h md-h${Math.min(b.level, 4)}`}>
            <Inline nodes={b.c} />
          </p>
        );
      case 'code':
        return (
          <pre key={i} className="code md-code">
            <code>{b.v}</code>
          </pre>
        );
      case 'quote':
        return (
          <blockquote key={i}>
            <Blocks nodes={b.c} />
          </blockquote>
        );
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={j}>
            <Blocks nodes={it} />
          </li>
        ));
        return b.ordered ? (
          <ol key={i} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
      case 'hr':
        return <hr key={i} />;
      case 'table':
        return (
          <div key={i} className="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} className={b.align[j] ? `al-${b.align[j]}` : undefined}>
                      <Inline nodes={c} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, k) => (
                  <tr key={k}>
                    {r.map((c, j) => (
                      <td key={j} className={b.align[j] ? `al-${b.align[j]}` : undefined}>
                        <Inline nodes={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** `fmt` 1 = markdown, anything else = plain text. */
export function Markdown({ text, markdown = true }: { text: string; markdown?: boolean }) {
  const tree = useMemo(() => (markdown ? parseMarkdown(text) : parsePlain(text)), [text, markdown]);
  return (
    <div className="md">
      <Blocks nodes={tree} />
    </div>
  );
}
