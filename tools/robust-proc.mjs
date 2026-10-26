// Linux helper for the robust-*/perf-* tools: resident memory of the Chromium processes started
// by this Node process (browser, GPU, renderer...), read from /proc. Returns {} elsewhere.
//   import { chromeMemory } from './robust-proc.mjs';  chromeMemory() -> { renderer: MB, gpu: MB, ... }
import fs from 'node:fs';

function children() {
  const map = new Map();
  let pids = [];
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return map;
  }
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!map.has(ppid)) map.set(ppid, []);
      map.get(ppid).push(Number(pid));
    } catch {
      /* process went away */
    }
  }
  return map;
}

export function chromeMemory(root = process.pid) {
  const kids = children();
  const out = {};
  const stack = [...(kids.get(root) || [])];
  while (stack.length) {
    const pid = stack.pop();
    stack.push(...(kids.get(pid) || []));
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes('chrom')) continue;
      const type = (/--type=([\w-]+)/.exec(cmd)?.[1] || 'browser').replace('-process', '');
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0) / 1024;
      out[type] = Math.round((out[type] || 0) + rss);
    } catch {
      /* gone */
    }
  }
  return out;
}
