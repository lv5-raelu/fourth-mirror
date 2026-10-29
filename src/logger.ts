export const logger = {
  info(message: string, ...details: unknown[]): void {
    console.info(new Date().toISOString(), 'INFO', message, ...details);
  },
  warn(message: string, ...details: unknown[]): void {
    console.warn(new Date().toISOString(), 'WARN', message, ...details);
  },
  error(message: string, ...details: unknown[]): void {
    console.error(new Date().toISOString(), 'ERROR', message, ...details);
  },
};

export type Logger = typeof logger;
