import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/** Emits sw.js with the list of built files to precache for offline use. */
function serviceWorker(): Plugin {
  let root = '';
  let publicDir = '';
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      publicDir = config.publicDir;
    },
    generateBundle(_, bundle) {
      const files = [...Object.keys(bundle), ...readdirSync(publicDir)].filter(
        (file) => file !== 'index.html' && !file.endsWith('.map'),
      );
      const source = readFileSync(resolve(root, 'src/sw.template.js'), 'utf8')
        // A new version string per build makes the browser install the updated worker.
        .replace('__VERSION__', String(Date.now()))
        .replace('__PRECACHE__', JSON.stringify(['./', ...files]));
      // Parse (without running) so a syntax error fails the build instead of silently breaking updates.
      new Function(source);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

function commitHash(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

/** Replaces %APP_VERSION% in index.html so you can tell which build is running. */
function appVersion(): Plugin {
  const version = commitHash();
  return {
    name: 'app-version',
    transformIndexHtml: (html) => html.replaceAll('%APP_VERSION%', version),
  };
}

export default defineConfig({
  base: '/video-delay-online/',
  // Phones only allow camera access over HTTPS, so the LAN dev server needs a cert.
  plugins: [basicSsl(), serviceWorker(), appVersion()],
});
