/**
 * PCM/WAV encoding, stitching, and text sanitization helpers.
 * Ported from supabase/functions/_shared/audioEngine.ts (Deno → Node).
 * Only change: base64Decode uses Buffer.from(str, "base64").
 */

const ALLOWED_PARALINGUISTIC_TAGS = [
  "clear throat","sigh","sush","cough","groan","sniff","gasp","chuckle","laugh",
];

// ── Text helpers ───────────────────────────────────────────────────

export function sanitizeVoiceover(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^\s*(?:hook|scene\s*\d+|narrator|body|solution|conflict|choice|formula)\s*[:\-–—]\s*/i, "")
        .replace(/^\s*\[[^\]]+\]\s*/g, ""),
    );
  let out = lines.join(" ");
  out = out.replace(/\[([^\]]+)\]/g, (match, content) => {
    const normalized = content.toLowerCase().trim();
    if (ALLOWED_PARALINGUISTIC_TAGS.includes(normalized)) return match;
    return " ";
  });
  out = out.replace(/[*_~`]+/g, "");
  return out.replace(/\s{2,}/g, " ").trim();
}

export function sanitizeForGeminiTTS(text: string): string {
  let sanitized = sanitizeVoiceover(text);
  const tagPlaceholders: string[] = [];
  sanitized = sanitized.replace(/\[([^\]]+)\]/g, (match, content) => {
    const normalized = content.toLowerCase().trim();
    if (ALLOWED_PARALINGUISTIC_TAGS.includes(normalized)) {
      tagPlaceholders.push(match);
      return `__PTAG${tagPlaceholders.length - 1}__`;
    }
    return " ";
  });
  sanitized = sanitized.replace(/[^\w\s\u00C0-\u024F\u1E00-\u1EFF.,!?;:'-]/g, " ");
  tagPlaceholders.forEach((tag, i) => {
    sanitized = sanitized.replace(`__PTAG${i}__`, tag);
  });
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  if (sanitized && !/[.!?]$/.test(sanitized)) sanitized += ".";
  return sanitized;
}

export function isHaitianCreole(text: string): boolean {
  const lower = text.toLowerCase();
  const indicators = [
    "mwen","ou","li","nou","yo","sa","ki","nan","pou","ak","pa","se","te","ap","gen",
    "fè","di","ale","vin","bay","konnen","wè","pran","mete","vle","kapab","dwe",
    "bezwen","tankou","paske","men","lè","si","kote","kouman","poukisa","anpil",
    "tout","chak","yon","ayiti","kreyòl","kreyol","bondye","mèsi","bonjou","bonswa",
    "kijan","eske","kounye","toujou","jamè","t ap","pral","ta",
  ];
  let count = 0;
  for (const w of indicators) {
    if (new RegExp(`\\b${w}\\b`, "gi").test(lower)) count++;
  }
  return count >= 3;
}

/** Detect French text from common French words (same approach as isHaitianCreole). */
export function isFrench(text: string): boolean {
  const lower = text.toLowerCase();
  const indicators = [
    "le","la","les","un","une","des","du","de","et","est","sont","dans","pour","avec",
    "sur","par","pas","plus","que","qui","ce","cette","ces","son","ses","nous","vous",
    "ils","elles","mon","ton","leur","mais","ou","donc","comme","aussi","très","bien",
    "alors","tout","tous","autre","même","être","avoir","faire","dire","aller","voir",
    "savoir","pouvoir","falloir","vouloir","entre","après","avant","depuis","encore",
    "toujours","jamais","beaucoup","peut","était","fait","monde","pendant","chaque",
    "jusqu","parce","histoire","cependant","également","travers","devient","commence",
  ];
  let count = 0;
  for (const w of indicators) {
    if (new RegExp(`\\b${w}\\b`, "gi").test(lower)) count++;
  }
  return count >= 4;
}

export function splitTextIntoChunks(text: string, maxChars = 400): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    if ((current + " " + t).trim().length > maxChars && current.trim()) {
      chunks.push(current.trim());
      current = t;
    } else {
      current = (current + " " + t).trim();
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text.trim()];
}

// ── PCM / WAV ──────────────────────────────────────────────────────

export function pcmToWav(
  pcmData: Uint8Array,
  sampleRate = 24000,
  numChannels = 1,
  bitsPerSample = 16,
): Uint8Array {
  const audioFormat = bitsPerSample === 32 ? 3 : 1;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  // RIFF
  [0x52,0x49,0x46,0x46].forEach((b,i) => view.setUint8(i,b));
  view.setUint32(4, 36 + dataSize, true);
  [0x57,0x41,0x56,0x45].forEach((b,i) => view.setUint8(8+i,b));
  // fmt
  [0x66,0x6d,0x74,0x20].forEach((b,i) => view.setUint8(12+i,b));
  view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data
  [0x64,0x61,0x74,0x61].forEach((b,i) => view.setUint8(36+i,b));
  view.setUint32(40, dataSize, true);
  const out = new Uint8Array(buffer);
  out.set(pcmData, 44);
  return out;
}

export function extractPcmFromWav(wav: Uint8Array): {
  pcm: Uint8Array; sampleRate: number; numChannels: number; bitsPerSample: number;
} {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let fmtOffset = -1;
  for (let i = 12; i < wav.length - 8; i++) {
    if (wav[i]===0x66 && wav[i+1]===0x6d && wav[i+2]===0x74 && wav[i+3]===0x20) { fmtOffset=i; break; }
  }
  if (fmtOffset < 0) throw new Error("No fmt chunk");
  const numChannels = view.getUint16(fmtOffset+10, true);
  const sampleRate = view.getUint32(fmtOffset+12, true);
  const bitsPerSample = view.getUint16(fmtOffset+22, true);
  let dataOffset = -1, dataSize = 0;
  for (let i = fmtOffset+8; i < wav.length-8; i++) {
    if (wav[i]===0x64 && wav[i+1]===0x61 && wav[i+2]===0x74 && wav[i+3]===0x61) {
      dataOffset = i+8; dataSize = view.getUint32(i+4, true); break;
    }
  }
  if (dataOffset < 0) throw new Error("No data chunk");
  return { pcm: wav.slice(dataOffset, dataOffset+dataSize), sampleRate, numChannels, bitsPerSample };
}

export function stitchWavBuffers(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) return new Uint8Array(0);
  if (buffers.length === 1) return buffers[0];
  const parsed = buffers.map((b) => extractPcmFromWav(b));
  const { sampleRate, numChannels, bitsPerSample } = parsed[0];
  const total = parsed.reduce((s, p) => s + p.pcm.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parsed) { merged.set(p.pcm, off); off += p.pcm.length; }
  return pcmToWav(merged, sampleRate, numChannels, bitsPerSample);
}

export function base64ToUint8Array(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
