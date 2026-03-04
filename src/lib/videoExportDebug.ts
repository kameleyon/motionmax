export type VideoExportLogLevel = "log" | "warn" | "error";

export interface VideoExportLogEntry {
  ts: number;
  level: VideoExportLogLevel;
  message: string;
}

const GLOBAL_KEY = "__motionmax_video_export_logs__";
const STORAGE_KEY = "motionmax_video_export_logs_v1";
const LEGACY_GLOBAL_KEY = "__audiomax_video_export_logs__";
const LEGACY_STORAGE_KEY = "audiomax_video_export_logs_v1";

function loadPersisted(): VideoExportLogEntry[] | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VideoExportLogEntry[];
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter(
        (e) =>
          e &&
          typeof (e as any).ts === "number" &&
          (e as any).level &&
          typeof (e as any).message === "string"
      )
      .slice(-300);
  } catch {
    return null;
  }
}

function persist(store: VideoExportLogEntry[]) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store.slice(-300)));
  } catch {
    // ignore (storage may be blocked)
  }
}

function getStore(): VideoExportLogEntry[] {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = (loadPersisted() ?? []) as VideoExportLogEntry[];
    // Migrate legacy global key if present.
    if (Array.isArray(g[LEGACY_GLOBAL_KEY]) && g[LEGACY_GLOBAL_KEY].length) {
      g[GLOBAL_KEY] = [...g[LEGACY_GLOBAL_KEY], ...g[GLOBAL_KEY]].slice(-300);
    }
  }
  return g[GLOBAL_KEY] as VideoExportLogEntry[];
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;

  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

export function appendVideoExportLog(level: VideoExportLogLevel, args: unknown[]) {
  const store = getStore();
  const message = args.map(safeStringify).join(" ");

  store.push({ ts: Date.now(), level, message });

  // Keep bounded to avoid memory bloat.
  const max = 300;
  if (store.length > max) store.splice(0, store.length - max);

  // Persist so logs survive mobile Safari refreshes/crashes.
  persist(store);
}

export function getVideoExportLogs() {
  return [...getStore()];
}

export function clearVideoExportLogs() {
  getStore().splice(0, getStore().length);
  persist([]);
}

export function formatVideoExportLogs(entries: VideoExportLogEntry[]) {
  return entries
    .map((e) => `${new Date(e.ts).toISOString()} [${e.level}] ${e.message}`)
    .join("\n");
}
