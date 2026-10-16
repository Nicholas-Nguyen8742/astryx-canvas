import {app} from 'electron';
import {join} from 'node:path';

/**
 * All mutable state lives under Electron's per-user data directory, which is
 * already namespaced by app name (TRD §16.3, §21.1). Nothing is written to the
 * install directory or to the user's home root.
 */
export const appPaths = {
  get root(): string {
    return app.getPath('userData');
  },
  get autosaveDir(): string {
    return join(app.getPath('userData'), 'autosave');
  },
  get logDir(): string {
    return join(app.getPath('userData'), 'logs');
  },
  get mainLog(): string {
    return join(app.getPath('userData'), 'logs', 'main.log');
  },
  get rendererLog(): string {
    return join(app.getPath('userData'), 'logs', 'renderer.log');
  },
  get recentStore(): string {
    return join(app.getPath('userData'), 'recent.json');
  },
  autosaveFile(documentId: string): string {
    return join(app.getPath('userData'), 'autosave', `${documentId}.astrx`);
  },
  autosaveMeta(documentId: string): string {
    return join(app.getPath('userData'), 'autosave', `${documentId}.meta.json`);
  }
};
