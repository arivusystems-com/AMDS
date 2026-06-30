import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { loadConfig } from '@vmds/shared';

let transporter: Transporter | null = null;

export function getTransporter(): Transporter {
  if (!transporter) {
    const config = loadConfig();
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      tls: { rejectUnauthorized: false },
    });
  }
  return transporter;
}
