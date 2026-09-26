import { useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Link } from 'react-router';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import type { MentionablesResponse } from '@shared/schemas/core';
import { Chip } from '@web/components/common/Chip';
import { UserHoverCard } from '@web/components/common/UserName';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@web/components/ui/dialog';
import { EVERYONE_SLUG } from '@web/lib/mentions';
import { cn } from '@web/lib/utils';
import { remarkMentions } from './remarkMentions';
import { sanitizeSchema } from './sanitize';
import { useMentionables } from './useMentionables';

/**
 * Read-only markdown (SPEC §1.13): GFM, sanitized (raw HTML never renders), highlighted code,
 * mention chips, constrained clickable images, external links in a new tab and read-only task
 * checkboxes. Pass `teamId` to resolve mentions to names, hover cards and role colors.
 */

function isExternal(href: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  try {
    return new URL(href).origin !== window.location.origin;
  } catch {
    return true;
  }
}

function MentionChip({
  kind,
  id,
  raw,
  mentionables,
}: {
  kind: string;
  id: string;
  raw: ReactNode;
  mentionables: MentionablesResponse | undefined;
}) {
  if (kind === 'role') {
    const role = mentionables?.roles.find((candidate) => candidate.slug === id);
    const name = id === EVERYONE_SLUG ? 'everyone' : (role?.name ?? id);
    return (
      <Chip color={role?.color ?? null} className="mx-px align-baseline" title={`Role: ${name}`}>
        @{name}
      </Chip>
    );
  }
  const user = mentionables?.users.find((candidate) => candidate.username === id);
  const chip = (
    <span className="mention rounded-sm bg-primary/10 px-0.5 font-medium text-primary dark:text-indigo-300">
      {raw}
    </span>
  );
  return user ? <UserHoverCard user={user}>{chip}</UserHoverCard> : chip;
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  return (
    <>
      <img
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        tabIndex={0}
        role="button"
        aria-label={alt ? `Open image: ${alt}` : 'Open image'}
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="max-h-96 max-w-full cursor-zoom-in rounded-md border object-contain"
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] w-auto max-w-[min(90vw,72rem)] p-2 sm:max-w-[min(90vw,72rem)]">
          <DialogTitle className="sr-only">{alt || 'Image'}</DialogTitle>
          <DialogDescription className="sr-only">Full-size image</DialogDescription>
          <img src={src} alt={alt ?? ''} className="max-h-[85vh] w-auto rounded object-contain" />
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="px-1 pb-1 text-xs text-muted-foreground hover:underline"
          >
            Open original
          </a>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Markdown sits below the page's own headings (the page h1 and its section h2s), so a README's
 * `# Title` must not become a second h1: `#` renders as an h3, `##` as an h4 and so on down to
 * h6, each keeping the look of its markdown level (`.md-h1` … in globals.css).
 */
const HEADING_OFFSET = 2;

function shiftedHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${Math.min(6, level + HEADING_OFFSET)}` as 'h3' | 'h4' | 'h5' | 'h6';
  return function MarkdownHeading({
    node: _node,
    className,
    ...props
  }: ComponentProps<'h1'> & { node?: unknown }) {
    return <Tag {...props} className={cn(`md-h${level}`, className)} />;
  };
}

const headings: Components = {
  h1: shiftedHeading(1),
  h2: shiftedHeading(2),
  h3: shiftedHeading(3),
  h4: shiftedHeading(4),
  h5: shiftedHeading(5),
  h6: shiftedHeading(6),
};

export interface MarkdownViewProps {
  /** Markdown source. */
  markdown: string;
  /** Resolves mentions (names, hover cards, role colors) against this team. */
  teamId?: string | null;
  className?: string;
}

export function MarkdownView({ markdown, teamId, className }: MarkdownViewProps) {
  const mentionables = useMentionables(teamId, markdown).data;

  const components: Components = {
    ...headings,
    a: ({ href = '', children, node: _node, ...props }) => {
      if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/')) {
        return (
          <Link to={href} {...props}>
            {children}
          </Link>
        );
      }
      const external = isExternal(href);
      return (
        <a
          href={href}
          {...props}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => (
      <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} />
    ),
    input: ({
      node: _node,
      type,
      checked,
      ...props
    }: ComponentProps<'input'> & { node?: unknown }) =>
      type === 'checkbox' ? (
        <input
          {...props}
          type="checkbox"
          checked={Boolean(checked)}
          readOnly
          disabled
          aria-label={checked ? 'Completed' : 'Not completed'}
          className="task-checkbox"
        />
      ) : null,
    span: ({ node: _node, children, ...props }) => {
      const data = props as Record<string, unknown>;
      const kind = data['data-mention'];
      const id = data['data-id'];
      if (typeof kind === 'string' && typeof id === 'string') {
        return <MentionChip kind={kind} id={id} raw={children} mentionables={mentionables} />;
      }
      return <span {...props}>{children}</span>;
    },
    table: ({ node: _node, ...props }) => (
      <div className="table-wrapper">
        <table {...props} />
      </div>
    ),
  };

  return (
    <div className={cn('markdown', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMentions]}
        rehypePlugins={[
          [rehypeSanitize, sanitizeSchema],
          [rehypeHighlight, { detect: false }],
        ]}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
