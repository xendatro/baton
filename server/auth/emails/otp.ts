import { OTP } from '@shared/constants';

/** Why a one-time code was sent (Better Auth's emailOTP types). */
export type OtpKind = 'email-verification' | 'forget-password' | 'sign-in' | 'change-email';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

interface OtpCopy {
  subject: string;
  heading: string;
  intro: string;
  ignore: string;
}

const COPY: Record<OtpKind, OtpCopy> = {
  'email-verification': {
    subject: 'Your Baton verification code',
    heading: 'Verify your email',
    intro: 'Enter this code to finish creating your Baton account:',
    ignore: "If you didn't create a Baton account, you can ignore this email.",
  },
  'forget-password': {
    subject: 'Reset your Baton password',
    heading: 'Reset your password',
    intro: 'Enter this code to choose a new password for your Baton account:',
    ignore:
      "If you didn't ask to reset your password, you can ignore this email. Your password won't change.",
  },
  'sign-in': {
    subject: 'Your Baton sign-in code',
    heading: 'Sign in to Baton',
    intro: 'Enter this code to sign in:',
    ignore: "If you didn't try to sign in, you can ignore this email.",
  },
  'change-email': {
    subject: 'Confirm your new Baton email',
    heading: 'Confirm your new email',
    intro: 'Enter this code to confirm this address for your Baton account:',
    ignore: "If you didn't ask to change your email, you can ignore this email.",
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain-text and HTML versions of a one-time-code email. */
export function renderOtpEmail(kind: OtpKind, code: string, baseUrl: string): RenderedEmail {
  const copy = COPY[kind];
  const minutes = Math.round(OTP.expiresInSeconds / 60);
  const expiry = `The code expires in ${minutes} minutes.`;

  const text = [
    copy.heading,
    '',
    copy.intro,
    '',
    `    ${code}`,
    '',
    expiry,
    copy.ignore,
    '',
    `Baton · ${baseUrl}`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(copy.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;">
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 24px;font-size:14px;font-weight:600;color:#6366f1;">Baton</p>
                <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;">${escapeHtml(copy.heading)}</h1>
                <p style="margin:0 0 20px;font-size:14px;line-height:20px;color:#3f3f46;">${escapeHtml(copy.intro)}</p>
                <p style="margin:0 0 20px;padding:12px 0;font-size:28px;font-weight:600;letter-spacing:8px;text-align:center;background:#f4f4f5;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(code)}</p>
                <p style="margin:0 0 8px;font-size:13px;line-height:18px;color:#52525b;">${escapeHtml(expiry)}</p>
                <p style="margin:0;font-size:13px;line-height:18px;color:#71717a;">${escapeHtml(copy.ignore)}</p>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0;font-size:12px;color:#a1a1aa;">${escapeHtml(baseUrl)}</p>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

  return { subject: copy.subject, text, html };
}
