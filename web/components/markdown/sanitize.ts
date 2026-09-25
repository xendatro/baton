import type rehypeSanitize from 'rehype-sanitize';
import { defaultSchema } from 'rehype-sanitize';

type HastSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

/**
 * GitHub-style sanitization plus the mention spans produced by `remarkMentions`. No clobber
 * prefix: raw HTML never renders, so the only ids are the footnote ids remark-rehype already
 * prefixes with `user-content-` (with a second prefix, footnote links pointed nowhere).
 */
export const sanitizeSchema: HastSchema = {
  ...defaultSchema,
  clobberPrefix: '',
  tagNames: [...(defaultSchema.tagNames ?? []), 'span'],
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), 'dataMention', 'dataId'],
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-[\w-]+$/]],
  },
  protocols: {
    ...defaultSchema.protocols,
    // Relative attachment URLs are always allowed; absolute image URLs must be http(s).
    src: ['http', 'https'],
  },
};
