/** Procedural Web Audio spatial synth: zero assets, tactile glass/pinch/fusion sounds. */

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;

  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx!.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx!.destination);
    } catch { this.ctx = null; }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.value = m ? 0 : 0.5;
  }

  get isMuted(): boolean { return this.muted; }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, when = 0, slideTo?: number): void {
    if (this.muted) return;
    this.ensure();
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx!.createOscillator();
    const g = this.ctx!.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  click(): void { this.tone(880, 0.09, 'sine', 0.25, 0, 1320); }
  hover(): void { this.tone(660, 0.06, 'sine', 0.12); }
  grab(): void { this.tone(320, 0.12, 'triangle', 0.25, 0, 520); }
  release(): void { this.tone(520, 0.1, 'triangle', 0.18, 0, 340); }
  spawn(): void {
    this.tone(523, 0.18, 'sine', 0.2);
    this.tone(784, 0.22, 'sine', 0.18, 0.07);
    this.tone(1046, 0.3, 'sine', 0.15, 0.14);
  }
  whoosh(): void {
    if (this.muted) return;
    this.ensure();
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime;
    const dur = 0.4;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(600, t0);
    f.frequency.exponentialRampToValueAtTime(3200, t0 + dur);
    const g = this.ctx.createGain();
    g.gain.value = 0.22;
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
  }
  pinchHum(level: number): void {
    // gentle rising shimmer while orbs approach; throttled by caller
    this.tone(440 + level * 440, 0.08, 'sine', 0.08);
  }
  fusionChord(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => this.tone(f, 0.7, 'sine', 0.2, i * 0.06));
    this.tone(261.6, 0.9, 'triangle', 0.15, 0);
  }
  auraWake(): void {
    this.tone(392, 0.25, 'sine', 0.2);
    this.tone(523, 0.25, 'sine', 0.2, 0.12);
    this.tone(659, 0.35, 'sine', 0.22, 0.24);
    this.tone(880, 0.5, 'sine', 0.2, 0.36);
  }
}

export const sound = new SoundEngine();
