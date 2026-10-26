"""Spectrogram PNGs for the WAVs written by tools/check-audio.mjs (numpy + PIL only).

    python3 tools/audio-spectrogram.py dist/shots/audio

Each PNG: a waveform envelope strip on top, then a log-frequency spectrogram (20 Hz .. 16 kHz)
with octave grid lines labelled, time ticks every second.
"""
import sys
import os
import wave
import numpy as np
from PIL import Image, ImageDraw

# inferno-ish colour ramp
STOPS = np.array([
    [0.0, 0, 0, 4], [0.15, 31, 12, 72], [0.3, 85, 15, 109], [0.45, 136, 34, 106],
    [0.6, 186, 54, 85], [0.75, 227, 89, 51], [0.88, 249, 140, 10], [1.0, 252, 255, 164],
])


def colormap(v):
    v = np.clip(v, 0, 1)
    out = np.zeros(v.shape + (3,), dtype=np.float64)
    for c in range(3):
        out[..., c] = np.interp(v, STOPS[:, 0], STOPS[:, c + 1])
    return out.astype(np.uint8)


def read_wav(path):
    with wave.open(path, 'rb') as w:
        ch, sr, n = w.getnchannels(), w.getframerate(), w.getnframes()
        data = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float64) / 32768.0
    data = data.reshape(-1, ch).mean(axis=1)
    return data, sr


def spectrogram(x, sr, width=1100, height=420, fmin=20.0, fmax=16000.0, nfft=8192, db_range=90.0):
    hop = max(1, len(x) // width)
    pad = np.concatenate([np.zeros(nfft // 2), x, np.zeros(nfft // 2)])
    win = np.hanning(nfft)
    cols = []
    for i in range(width):
        s = i * hop
        frame = pad[s:s + nfft]
        if len(frame) < nfft:
            frame = np.concatenate([frame, np.zeros(nfft - len(frame))])
        cols.append(np.abs(np.fft.rfft(frame * win)))
    mag = np.array(cols).T  # (bins, width)
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    rows = np.geomspace(fmax, fmin, height)
    img = np.empty((height, width))
    for r, f in enumerate(rows):
        # average the bins that fall in this row's band
        lo, hi = f / 2 ** (1 / 48), f * 2 ** (1 / 48)
        idx = np.where((freqs >= lo) & (freqs <= hi))[0]
        if len(idx) == 0:
            idx = [np.argmin(np.abs(freqs - f))]
        img[r] = mag[idx].mean(axis=0)
    db = 20 * np.log10(img + 1e-9)
    db -= db.max()
    return np.clip((db + db_range) / db_range, 0, 1), rows, hop


def render(path, out):
    x, sr = read_wav(path)
    width, height, strip = 1100, 420, 90
    spec, rows, hop = spectrogram(x, sr, width, height)
    im = Image.new('RGB', (width + 60, height + strip + 40), (12, 8, 10))
    im.paste(Image.fromarray(colormap(spec)), (60, strip + 10))
    d = ImageDraw.Draw(im)
    # waveform envelope (peak per column, dB-ish scale)
    for i in range(width):
        seg = x[i * hop:(i + 1) * hop]
        if len(seg) == 0:
            continue
        p = np.abs(seg).max()
        h = int((strip - 10) * p)
        d.line([(60 + i, strip - h // 2), (60 + i, strip - h // 2 + h)], fill=(200, 120, 100))
    d.text((60, 2), f'{os.path.basename(path)}  peak {np.abs(x).max():.3f}  {len(x) / sr:.2f}s', fill=(230, 220, 210))
    # octave grid
    for f in [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]:
        r = int(np.interp(np.log(f), np.log(rows[::-1]), np.arange(height)[::-1]))
        y = strip + 10 + r
        d.line([(60, y), (60 + width, y)], fill=(70, 70, 80))
        d.text((4, y - 6), f'{f:g}' if f < 1000 else f'{f / 1000:g}k', fill=(200, 200, 200))
    dur = len(x) / sr
    for s in range(int(dur) + 1):
        xx = 60 + int(s / dur * width)
        d.line([(xx, strip + 10 + height), (xx, strip + 16 + height)], fill=(200, 200, 200))
        d.text((xx - 3, strip + 18 + height), str(s), fill=(200, 200, 200))
    im.save(out)


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else 'dist/shots/audio'
    names = sorted(n for n in os.listdir(folder) if n.endswith('.wav'))
    for n in names:
        render(os.path.join(folder, n), os.path.join(folder, n[:-4] + '.png'))
    print(f'spectrograms: {len(names)} written to {folder}')


if __name__ == '__main__':
    main()
