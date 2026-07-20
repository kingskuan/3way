// 宠物系统：每家 DEX 一只宠物，交易量 = 养料，累积到阈值就进化。
//
// 设计原则：
//   1. 养料只涨不跌（跟 bot.stats.volume 的 delta 挂钩；bot 重置统计不会掉养料）
//   2. 6 阶进化（Lv1 幼卵 → Lv6 传说），阈值指数级递增
//   3. 每所有专属主题（Decibel 声鸟 / Extended 链龙 / RISEx 崛凤 /
//      Ondo 潮兽 / Perpl 影狼 / StandX 战星）
//   4. 状态持久化在 .state.json 的 'pets' key 下，重启不掉
import { loadSnapshot, saveSnapshot } from './persist.js';

const KEYS = ['de', 'ex', 'rs', 'on', 'pl', 'sx'];

// 6 阶阈值（USDC 累积交易量）——指数递增，越到后期越难升
export const LEVEL_THRESHOLDS = [0, 100, 1000, 5000, 25000, 100000];

// 每所专属宠物：6 阶 emoji 序列 + 主题名 + 颜色（跟 DEX 主色对应）
export const PET_SPECIES = {
  de: {
    name: '声波幼鸟', theme: 'Decibel · 声之息',
    stages: ['🥚', '🐣', '🐥', '🦜', '🦉', '🦅'],
    color: '#f59e0b',
  },
  ex: {
    name: '延展链龙', theme: 'Extended · 链之延',
    stages: ['🥚', '🐛', '🐍', '🦎', '🐊', '🐉'],
    color: '#3b82f6',
  },
  rs: {
    name: '崛起火凤', theme: 'RISEx · 上升之翼',
    stages: ['🥚', '🐣', '🕊️', '🦩', '🦚', '🔥'],
    color: '#10b981',
  },
  on: {
    name: '深潮巨兽', theme: 'Ondo · 波动之海',
    stages: ['🥚', '🐚', '🐟', '🐡', '🐙', '🐋'],
    color: '#06b6d4',
  },
  pl: {
    name: '永劫影狼', theme: 'Perpl · 永续之影',
    stages: ['🥚', '🐺', '🦊', '🐆', '🦁', '🐯'],
    color: '#ec4899',
  },
  sx: {
    name: '战星魔兽', theme: 'StandX · 立地之魂',
    stages: ['🥚', '🦎', '🦂', '🦖', '🐲', '👑'],
    color: '#8b5cf6',
  },
};

function _freshPet() {
  return { feed: 0, seenVol: 0 };
}

export function createPets({ bots }) {
  return new Pets({ bots });
}

class Pets {
  constructor({ bots }) {
    this.bots = bots;
    const saved = loadSnapshot('pets') || {};
    this.state = {};
    for (const k of KEYS) {
      this.state[k] = { ..._freshPet(), ...(saved[k] || {}) };
    }
  }

  start() {
    // 60s 拉一次 bot 的当前 volume；bot 侧同样 60s 从 exchange 同步 volume——
    // 这里的 tick 只做 delta → feed 累积。
    this._tick();
    this._timer = setInterval(() => this._tick(), 60_000);
    this._timer.unref?.();
  }

  _tick() {
    let changed = false;
    for (const k of KEYS) {
      const bot = this.bots[k];
      const v = Number(bot?.getState?.()?.volume) || 0;
      const seen = this.state[k].seenVol || 0;
      if (v > seen) {
        // 正常增量：加进 feed
        this.state[k].feed = Math.round((this.state[k].feed + (v - seen)) * 100) / 100;
        this.state[k].seenVol = v;
        changed = true;
      } else if (v < seen) {
        // bot 统计被重置：只对齐 seenVol，不动 feed（宠物养料不能倒退）
        this.state[k].seenVol = v;
        changed = true;
      }
    }
    if (changed) saveSnapshot('pets', this.state);
  }

  status() {
    const out = { thresholds: LEVEL_THRESHOLDS, species: PET_SPECIES, pets: {} };
    for (const k of KEYS) {
      const feed = this.state[k].feed || 0;
      // level = 满足阈值的最高档 (0..5)
      let level = 0;
      for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
        if (feed >= LEVEL_THRESHOLDS[i]) level = i;
      }
      const nextThreshold = LEVEL_THRESHOLDS[level + 1] || null;
      const prevThreshold = LEVEL_THRESHOLDS[level] || 0;
      out.pets[k] = { feed, level, nextThreshold, prevThreshold };
    }
    return out;
  }
}
