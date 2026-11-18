/** Real voice input with three tiers (no placeholders):
 *  1. Meta Muse Voice Transcribe — active only if the host app supplies a key
 *     via setMetaKey (this app keeps keys server-side, so this tier stays off
 *     and voice falls through below). Push-to-talk: tap mic to record, tap
 *     again to transcribe via POST /v1/asr/transcribe.
 *  2. Web Speech API recognition (desktop Chrome/Edge, no key needed).
 *  3. Typed input fallback with an honest caption.
 * Speech output uses the device speechSynthesis engine.
 */

export type VoiceState = 'idle' | 'listening' | 'unsupported';

interface SpeechRecog extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: unknown) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const TRANSCRIBE_URL = 'https://api.meta.ai/v1/asr/transcribe';
const TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';

function transcriptOf(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const j = json as Record<string, unknown>;
  if (typeof j['transcript'] === 'string') return (j['transcript'] as string).trim();
  if (typeof j['text'] === 'string') return (j['text'] as string).trim();
  for (const key of ['turns', 'results', 'segments']) {
    const arr = j[key];
    if (Array.isArray(arr)) {
      const t = arr
        .map((t) => {
          if (typeof t === 'string') return t;
          if (t && typeof t === 'object') {
            const r = t as Record<string, unknown>;
            return String(r['transcript'] || r['text'] || '');
          }
          return '';
        })
        .join(' ')
        .trim();
      if (t) return t;
    }
  }
  return '';
}

/** Resample any decoded AudioBuffer down to mono 16 kHz for the transcribe API. */
async function toMono16k(buffer: AudioBuffer): Promise<AudioBuffer> {
  const targetRate = 16000;
  if (buffer.sampleRate === targetRate && buffer.numberOfChannels === 1) return buffer;
  const frames = Math.ceil((buffer.duration * targetRate) + 1);
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0);
  return await offline.startRendering();
}

/** Encode mono 16-bit PCM WAV (RIFF) — the container the transcribe API requires. */
function encodeWav(buffer: AudioBuffer): Blob {
  const data = buffer.getChannelData(0);
  const n = data.length;
  const bytes = new ArrayBuffer(44 + n * 2);
  const v = new DataView(bytes);
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, buffer.sampleRate, true);
  v.setUint32(28, buffer.sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export class VoiceController {
  onResult: (text: string) => void = () => undefined;
  onCaption: (text: string) => void = () => undefined;
  onListenState: (listening: boolean) => void = () => undefined;
  private recog: SpeechRecog | null = null;
  private listening = false;
  private muted = false;
  private metaKey = '';
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private autoStop: number | null = null;

  setMetaKey(key: string): void { this.metaKey = (key || '').trim(); }

  get usingMeta(): boolean { return this.metaKey.length > 0; }

  get supported(): boolean {
    if (this.usingMeta) return true;
    const w = window as unknown as Record<string, unknown>;
    return typeof w['SpeechRecognition'] === 'function' || typeof w['webkitSpeechRecognition'] === 'function';
  }

  get isListening(): boolean { return this.listening; }

  setMuted(m: boolean): void {
    this.muted = m;
    if (m) window.speechSynthesis?.cancel();
  }

  start(): void {
    if (this.listening) { this.stop(); return; }
    if (this.usingMeta) { void this.startMetaRecording(); return; }
    this.startWebSpeech();
  }

  stop(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { this.finishMetaFail('Recording stopped with an error.'); }
      return; // onstop continues the pipeline
    }
    try { this.recog?.stop(); } catch { /* ignore */ }
    this.teardownStream();
    this.listening = false;
    this.onListenState(false);
  }

  speak(text: string): void {
    this.onCaption(text);
    if (this.muted) return;
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text.slice(0, 220));
      u.rate = 1.05;
      u.pitch = 1.0;
      synth.speak(u);
    } catch { /* silent */ }
  }

  /* ---------- Meta Muse transcription path ---------- */

  private async startMetaRecording(): Promise<void> {
    this.teardownStream();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      this.onCaption('Microphone blocked — allow mic access or type your goal below.');
      this.onListenState(false);
      return;
    }
    this.stream = stream;
    this.chunks = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch {
      this.onCaption('Recording is not supported here — type your goal below.');
      this.teardownStream();
      return;
    }
    this.recorder = recorder;
    recorder.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    recorder.onstop = () => { void this.transcribeChunks(); };
    recorder.onerror = () => this.finishMetaFail('Recording failed — try again or type your goal.');
    try {
      recorder.start();
    } catch {
      this.finishMetaFail('Could not start recording.');
      return;
    }
    this.listening = true;
    this.onListenState(true);
    this.onCaption('Recording… tap the mic again to transcribe.');
    if (this.autoStop) window.clearTimeout(this.autoStop);
    this.autoStop = window.setTimeout(() => { if (this.listening) this.stop(); }, 45000);
  }

  private async transcribeChunks(): Promise<void> {
    const blob = new Blob(this.chunks, { type: this.recorder?.mimeType || 'audio/webm' });
    this.chunks = [];
    this.teardownStream();
    this.onCaption('Transcribing with Muse…');
    try {
      if (!blob.size) throw new Error('empty recording');
      const raw = await blob.arrayBuffer();
      const ctx = new AudioContext();
      let decoded: AudioBuffer;
      try {
        decoded = await ctx.decodeAudioData(raw.slice(0));
      } finally {
        void ctx.close().catch(() => undefined);
      }
      const mono = await toMono16k(decoded);
      const wav = encodeWav(mono);
      const form = new FormData();
      form.append('request', JSON.stringify({ model: TRANSCRIBE_MODEL, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' }));
      form.append('audio', wav, 'recording.wav');
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 60000);
      let res: Response;
      try {
        res = await fetch(TRANSCRIBE_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${this.metaKey}`, Accept: 'application/json' },
          body: form
        });
      } finally {
        window.clearTimeout(timer);
      }
      if (res.status === 401 || res.status === 403) throw new Error('key');
      if (!res.ok) throw new Error(`http ${res.status}`);
      const json: unknown = await res.json();
      const text = transcriptOf(json);
      this.listening = false;
      this.onListenState(false);
      if (text) {
        this.onResult(text);
      } else {
        this.onCaption('Heard nothing clear — try again or type your goal.');
      }
    } catch (e) {
      this.listening = false;
      this.onListenState(false);
      if (e instanceof Error && e.message === 'key') {
        this.onCaption('Transcription key rejected — reconnect AI, or type your goal.');
      } else {
        this.onCaption('Transcription failed — try again or type your goal below.');
      }
    }
    if (this.autoStop) { window.clearTimeout(this.autoStop); this.autoStop = null; }
  }

  private finishMetaFail(msg: string): void {
    this.teardownStream();
    this.listening = false;
    this.onListenState(false);
    this.onCaption(msg);
  }

  private teardownStream(): void {
    this.recorder = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
      this.stream = null;
    }
  }

  /* ---------- Web Speech path (desktop browsers) ---------- */

  private startWebSpeech(): void {
    const w = window as unknown as Record<string, new () => SpeechRecog>;
    const Ctor = w['SpeechRecognition'] || w['webkitSpeechRecognition'];
    if (!Ctor) {
      this.onCaption('Voice is not supported here — type your goal below.');
      this.onResult('');
      return;
    }
    try {
      this.recog = new Ctor();
      this.recog.lang = 'en-US';
      this.recog.interimResults = false;
      this.recog.maxAlternatives = 1;
      this.recog.continuous = false;
      this.recog.onresult = (ev: unknown) => {
        const e = ev as { results: ArrayLike<ArrayLike<{ transcript: string }>> };
        const text = e.results?.[0]?.[0]?.transcript || '';
        if (text) this.onResult(text);
      };
      this.recog.onend = () => {
        this.listening = false;
        this.onListenState(false);
      };
      this.recog.onerror = () => {
        this.listening = false;
        this.onListenState(false);
        this.onCaption('Microphone blocked — type your goal below instead.');
      };
      this.recog.start();
      this.listening = true;
      this.onListenState(true);
      this.onCaption('Listening… speak your goal.');
    } catch {
      this.onCaption('Microphone unavailable — type your goal below.');
    }
  }
}
