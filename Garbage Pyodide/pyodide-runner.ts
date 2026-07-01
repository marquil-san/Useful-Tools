import type { TerminalLine } from './types';

// ── Pyodide types ─────────────────────────────────────────────────────────────
interface PyodideInterface {
  runPythonAsync: (code: string) => Promise<unknown>;
  setStdout: (opts: { batched: (line: string) => void }) => void;
  setStderr: (opts: { batched: (line: string) => void }) => void;
  loadPackage: (pkg: string | string[]) => Promise<void>;
}

declare global {
  interface Window {
    loadPyodide: (config: { indexURL: string }) => Promise<PyodideInterface>;
    __nobs_input__: (prompt: string) => string;
  }
}

const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/';

// ── Singleton — starts loading the moment this module is first imported ────────
let _promise: Promise<PyodideInterface> | null = null;

export function initPyodide(): Promise<PyodideInterface> {
  if (!_promise) {
    _promise = (async () => {
      // loadPyodide is injected by the <script> tag in index.html
      const py = await window.loadPyodide({ indexURL: PYODIDE_CDN });
      // Pre-load micropip so `pip install` works immediately
      await py.loadPackage('micropip');
      // Patch input() once for the lifetime of this session
      await py.runPythonAsync(`
import builtins
import js as _js

def _input(prompt=''):
    return _js.__nobs_input__(str(prompt) if prompt else '')

builtins.input = _input
`);
      return py;
    })();
  }
  return _promise;
}

// ── pip install support via micropip ─────────────────────────────────────────
export async function installPackages(
  packages: string[],
  onOutput: (line: TerminalLine) => void,
): Promise<void> {
  let py: PyodideInterface;
  try {
    py = await initPyodide();
  } catch {
    onOutput({ type: 'error', text: 'Python runtime not available.' });
    return;
  }

  for (const pkg of packages) {
    onOutput({ type: 'info', text: `Collecting ${pkg}…` });
    try {
      await py.runPythonAsync(`
import micropip
await micropip.install(${JSON.stringify(pkg)})
`);
      onOutput({ type: 'info', text: `✓ Successfully installed ${pkg}` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onOutput({ type: 'error', text: `Failed to install ${pkg}: ${msg}` });
    }
  }
}

// ── Error cleanup ─────────────────────────────────────────────────────────────
function formatError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Pyodide wraps Python errors — extract just the Python traceback
  const match = raw.match(/PythonError:\s*([\s\S]+)/);
  return match ? match[1].trim() : raw;
}

// ── Run user code ─────────────────────────────────────────────────────────────
export async function runPython(
  code: string,
  onOutput: (line: TerminalLine) => void,
  _onInput: (prompt: string) => Promise<string>, // kept for API compatibility
): Promise<void> {
  let py: PyodideInterface;
  try {
    py = await initPyodide();
  } catch {
    onOutput({ type: 'error', text: 'Python runtime failed to load. Check your connection and refresh the page.' });
    return;
  }

  // Redirect stdout/stderr — batched fires once per line
  py.setStdout({ batched: (line) => onOutput({ type: 'output', text: line }) });
  py.setStderr({ batched: (line) => { if (line.trim()) onOutput({ type: 'error', text: line }); } });

  // Sync input bridge: window.prompt() is the only truly synchronous
  // user-facing blocking call available in a single-threaded browser.
  // The prompt + response are echoed into the terminal for session visibility.
  window.__nobs_input__ = (prompt: string): string => {
    const p = String(prompt ?? '');
    if (p) onOutput({ type: 'output', text: p });
    const result = window.prompt(p) ?? '';
    onOutput({ type: 'input', text: result });
    return result;
  };

  try {
    await py.runPythonAsync(code);
  } catch (err: unknown) {
    onOutput({ type: 'error', text: formatError(err) });
  }
}
