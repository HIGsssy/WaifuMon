import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(level: string = 'info'): Logger {
  return pino({
    level,
    base: { app: 'waifumon-bot' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
