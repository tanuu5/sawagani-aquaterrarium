// 水の音を WebAudio で合成する（音源ファイルは使わない）
export class Soundscape {
  constructor() {
    this.ctx = null;
    this.on = false;
    this.timer = null;
  }

  _build() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    // ノイズバッファ
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099;
      b1 = 0.963 * b1 + w * 0.2965;
      b2 = 0.57 * b2 + w * 1.0526;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
    this.noiseBuf = buf;
    // 滝のさらさら音
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = 0.22;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.23;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.06;
    lfo.connect(lfoG).connect(g.gain);
    src.connect(bp).connect(g).connect(this.master);
    src.start(); lfo.start();
    // 低いせせらぎ
    const src2 = ctx.createBufferSource();
    src2.buffer = buf; src2.loop = true; src2.playbackRate.value = 0.6;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    const g2 = ctx.createGain(); g2.gain.value = 0.18;
    src2.connect(lp).connect(g2).connect(this.master);
    src2.start();
    this.dropBus = ctx.createGain();
    this.dropBus.gain.value = 0.5;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 500;
    this.dropBus.connect(hp).connect(this.master);
  }

  _drop() {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f0 = 900 + Math.random() * 1600;
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * (1.4 + Math.random() * 0.8), t + 0.05);
    const a = 0.02 + Math.random() * 0.05;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(a, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07 + Math.random() * 0.05);
    o.connect(g).connect(this.dropBus);
    o.start(t); o.stop(t + 0.15);
  }

  async enable() {
    if (!this.ctx) this._build();
    await this.ctx.resume();
    this.on = true;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(0.55, this.ctx.currentTime, 0.4);
    const loop = () => {
      if (!this.on) return;
      this._drop();
      if (Math.random() < 0.3) this._drop();
      this.timer = setTimeout(loop, 40 + Math.random() * 180);
    };
    clearTimeout(this.timer);
    loop();
  }

  disable() {
    this.on = false;
    clearTimeout(this.timer);
    if (this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
  }

  // ガラスをたたく音
  tap() {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const tt = t + i * 0.16;
      const o = ctx.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(420, tt); o.frequency.exponentialRampToValueAtTime(180, tt + 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt); g.gain.exponentialRampToValueAtTime(0.5, tt + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.16);
      o.connect(g).connect(this.master); o.start(tt); o.stop(tt + 0.2);
      const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 1.2;
      const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.25, tt); g2.gain.exponentialRampToValueAtTime(0.0001, tt + 0.05);
      n.connect(bp).connect(g2).connect(this.master); n.start(tt, Math.random()); n.stop(tt + 0.06);
    }
  }

  // 餌が水に落ちる音
  splash() {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(500, t); o.frequency.exponentialRampToValueAtTime(1500, t + 0.06);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.15);
  }
}
