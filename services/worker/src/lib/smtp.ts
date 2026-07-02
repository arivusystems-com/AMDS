import dns from 'node:dns/promises';
import nodemailer from 'nodemailer';
import {
  classifySmtpError,
  loadConfig,
  type MailSendOptions,
  type MailSendResult,
} from '@vmds/shared';

export type { MailSendOptions as MailOptions };

function buildMailPayload(options: MailSendOptions) {
  const mail: nodemailer.SendMailOptions = {
    from: options.from.name
      ? `"${options.from.name}" <${options.from.email}>`
      : options.from.email,
    to: options.to
      .map((r) => (r.name ? `"${r.name}" <${r.email}>` : r.email))
      .join(', '),
    subject: options.subject,
    html: options.html,
    text: options.text ?? (options.html ? undefined : options.subject),
  };

  if (options.dkim) {
    mail.dkim = {
      domainName: options.dkim.domainName,
      keySelector: options.dkim.keySelector,
      privateKey: options.dkim.privateKey,
    };
  }

  return mail;
}

export async function resolveMxHost(domain: string): Promise<string> {
  const records = await dns.resolveMx(domain);
  if (records.length === 0) {
    throw classifySmtpError(new Error(`No MX records found for ${domain}`));
  }
  records.sort((a, b) => a.priority - b.priority);
  return records[0].exchange;
}

export async function sendDirectMail(options: MailSendOptions): Promise<MailSendResult> {
  const recipientDomain = options.to[0].email.split('@')[1];
  const mxHost = await resolveMxHost(recipientDomain);

  const transporter = nodemailer.createTransport({
    host: mxHost,
    port: 25,
    secure: false,
    tls: { rejectUnauthorized: false },
  });

  try {
    const info = await transporter.sendMail(buildMailPayload(options));
    return {
      messageId: info.messageId,
      response: info.response ?? '250 OK',
    };
  } catch (err) {
    throw classifySmtpError(err);
  } finally {
    transporter.close();
  }
}

export async function sendRelayMail(options: MailSendOptions): Promise<MailSendResult> {
  const config = loadConfig();
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    tls: { rejectUnauthorized: false },
  });

  try {
    const info = await transporter.sendMail(buildMailPayload(options));
    return {
      messageId: info.messageId,
      response: info.response ?? '250 OK',
    };
  } catch (err) {
    throw classifySmtpError(err);
  } finally {
    transporter.close();
  }
}

export async function sendMail(options: MailSendOptions): Promise<MailSendResult> {
  const config = loadConfig();
  if (config.SMTP_MODE === 'direct') {
    return sendDirectMail(options);
  }
  return sendRelayMail(options);
}
