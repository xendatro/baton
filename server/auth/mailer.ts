import fs from 'node:fs';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../env';
import { newId } from '../lib/ids';
import type { Logger } from '../logger';
import { renderOtpEmail, type OtpKind } from './emails/otp';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** Sends an email. Rejects when SMTP delivery fails. */
  send(message: EmailMessage, meta?: Record<string, unknown>): Promise<void>;
  /** Sends a verification or password-reset code. */
  sendOtp(to: string, kind: OtpKind, code: string): Promise<void>;
}

export type MailerEnv = Pick<Env, 'smtpUrl' | 'mailFrom' | 'baseUrl' | 'dataDir' | 'e2eMailbox'>;

/** Folder the test mailbox writes to (`E2E_MAILBOX=true`). */
export function mailboxDir(dataDir: string): string {
  return path.join(dataDir, 'mailbox');
}

/**
 * nodemailer over `SMTP_URL`. Without SMTP, emails are written to the log instead (with a warning
 * at startup) so development works without a mail server. With `E2E_MAILBOX=true`, every email is
 * also saved as JSON in `DATA_DIR/mailbox/` — synchronously, before delivery starts, so a test can
 * read the code as soon as the triggering request returns.
 */
export function createMailer(env: MailerEnv, logger: Logger): Mailer {
  const transport: Transporter | null = env.smtpUrl
    ? nodemailer.createTransport(env.smtpUrl)
    : null;
  if (!transport) {
    logger.warn('SMTP_URL is not set: emails will be logged to the console instead of sent');
  }

  function writeToMailbox(message: EmailMessage, meta: Record<string, unknown>): void {
    const dir = mailboxDir(env.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${newId()}.json`);
    const record = { ...message, ...meta, sentAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
  }

  const mailer: Mailer = {
    async send(message, meta = {}) {
      if (env.e2eMailbox) writeToMailbox(message, meta);
      if (!transport) {
        logger.info(
          { to: message.to, subject: message.subject, body: message.text },
          'email not sent (SMTP_URL is not set)',
        );
        return;
      }
      await transport.sendMail({ from: env.mailFrom, ...message });
      logger.info({ to: message.to, subject: message.subject }, 'email sent');
    },
    sendOtp(to, kind, code) {
      return mailer.send({ to, ...renderOtpEmail(kind, code, env.baseUrl) }, { kind, code });
    },
  };
  return mailer;
}
