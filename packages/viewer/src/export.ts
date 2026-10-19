// Export clip (spec §10.4): records the highlight reel to WebM. The 3D canvas holds no text (labels
// are DOM), so each frame is composited onto a 2D canvas with simple name pills drawn on top.

export interface LabelSpot {
  x: number;
  y: number;
  name: string;
  color: string;
  alert: boolean;
}

export class ClipRecorder {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  recording = false;

  static supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  start(width: number, height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width);
    this.canvas.height = Math.round(height);
    this.ctx = this.canvas.getContext('2d')!;
    const stream = this.canvas.captureStream(30);
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';
    this.chunks = [];
    this.rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000 });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    this.recording = true;
  }

  /** Call right after the scene rendered this frame. */
  frame(source: HTMLCanvasElement, labels: LabelSpot[], caption: string) {
    const g = this.ctx;
    const c = this.canvas;
    if (!g || !c || !this.recording) return;
    const grad = g.createRadialGradient(c.width / 2, c.height * 0.38, 0, c.width / 2, c.height * 0.38, c.width * 0.7);
    grad.addColorStop(0, '#fbfcfd');
    grad.addColorStop(1, '#e3e7ec');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(source, 0, 0, c.width, c.height);
    const sx = c.width / source.clientWidth;
    const sy = c.height / source.clientHeight;
    g.font = `600 ${Math.round(12 * sx)}px Rubik, system-ui, sans-serif`;
    for (const l of labels) {
      const w = g.measureText(l.name).width + 26 * sx;
      const h = 20 * sy;
      const x = l.x * sx - w / 2;
      const y = l.y * sy - h - 6 * sy;
      g.fillStyle = l.alert ? '#fff6d6' : 'rgba(255,255,255,0.94)';
      g.beginPath();
      g.roundRect(x, y, w, h, h / 2);
      g.fill();
      g.fillStyle = l.color;
      g.beginPath();
      g.arc(x + 10 * sx, y + h / 2, 4 * sx, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#1d2433';
      g.fillText(l.name, x + 18 * sx, y + h / 2 + 4 * sy);
    }
    g.font = `500 ${Math.round(13 * sx)}px Rubik, system-ui, sans-serif`;
    g.fillStyle = 'rgba(29,36,51,0.85)';
    g.fillText(caption, 14 * sx, 24 * sy);
    g.font = `${Math.round(8 * sx)}px Rubik, system-ui, sans-serif`;
    g.fillStyle = '#b8bdc4';
    g.textAlign = 'right';
    g.fillText('© Debaditya Chakravorty · Deb', c.width - 10 * sx, c.height - 8 * sy);
    g.textAlign = 'left';
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.rec;
      this.recording = false;
      if (!rec) return resolve(new Blob());
      rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType }));
      rec.stop();
    });
  }
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
