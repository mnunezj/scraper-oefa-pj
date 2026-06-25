/**
 * Logger minimalista con niveles y marca de tiempo.
 * Escribe a consola y (opcionalmente) a un archivo de log.
 */
import * as fs from 'fs';
import * as path from 'path';

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<Level, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

class Logger {
  private minLevel: Level = 'INFO';
  private logFile: string | null = null;

  /** Configura el nivel mínimo y, si se indica, el archivo de salida. */
  configure(opts: { level?: Level; logFile?: string }) {
    if (opts.level) this.minLevel = opts.level;
    if (opts.logFile) {
      this.logFile = opts.logFile;
      fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
    }
  }

  private write(level: Level, msg: string) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    // eslint-disable-next-line no-console
    console.log(line);
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, line + '\n');
      } catch {
        /* si falla el log a archivo, no interrumpimos el scraping */
      }
    }
  }

  debug(msg: string) { this.write('DEBUG', msg); }
  info(msg: string) { this.write('INFO', msg); }
  warn(msg: string) { this.write('WARN', msg); }
  error(msg: string) { this.write('ERROR', msg); }
}

export const logger = new Logger();
