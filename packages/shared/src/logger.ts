type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  service?: string;
  message_id?: string;
  tenant_id?: string;
  event?: string;
  [key: string]: unknown;
}

function write(level: LogLevel, fields: LogFields, message: string): void {
  const entry = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(service: string) {
  return {
    debug(message: string, fields: LogFields = {}) {
      write('debug', { service, ...fields }, message);
    },
    info(message: string, fields: LogFields = {}) {
      write('info', { service, ...fields }, message);
    },
    warn(message: string, fields: LogFields = {}) {
      write('warn', { service, ...fields }, message);
    },
    error(message: string, fields: LogFields = {}) {
      write('error', { service, ...fields }, message);
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
