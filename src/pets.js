// 宠物系统：每家 DEX 一只宠物，交易量 = 养料，累积到阈值就进化。
//
// 设计原则：
//   1. 养料只涨不跌（跟 bot.stats.volume 的 delta 挂钩；bot 重置统计不会掉养料）
//   2. 6 阶进化（Lv1 幼卵 → Lv6 传说），阈值指数级递增
//   3. 每所有专属主题（Decibel 声鸟 / Extended 链龙 / RISEx 崛凤 /
//      Ondo 潮兽 / Perpl 影狼 / StandX 战星）
//   4. 状态持久化在 .state.json 的 'pets' key 下，重启不掉
import { loadSnapshot, saveSnapshot } from './persist.js';

const KEYS = ['de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg'];

// 6 阶阈值（USDC 累积交易量）——指数递增，越到后期越难升
export const LEVEL_THRESHOLDS = [0, 100, 1000, 5000, 25000, 100000];

// 每所专属宠物：中国古代神兽 · 6 阶进化 · gpt-image-1 手绘立绘
//   stageNames: 每阶专名（UI 显示）
//   fallback: 图片加载失败时的 emoji 兜底
//   image path 惯例：/pets/{key}-lv{1..6}.png
export const PET_SPECIES = {
  de: {
    name: '朱雀', theme: '南方火神 · 声鸣震天',
    stageNames: ['灵卵', '雏雀', '鸣禽', '赤翎', '焚天雀', '朱雀神'],
    fallback: ['🥚', '🐣', '🐦', '🦜', '🔥', '🦅'],
    color: '#dc2626',
  },
  ex: {
    name: '青龙', theme: '东方木神 · 千里游延',
    stageNames: ['龙卵', '虺', '蛟', '应龙', '蟠龙', '青龙神'],
    fallback: ['🥚', '🐛', '🐍', '🦎', '🐊', '🐉'],
    color: '#0ea5e9',
  },
  rs: {
    name: '鲲鹏', theme: '化鲲为鹏 · 扶摇直上',
    stageNames: ['鱼卵', '幼鲲', '大鲲', '巨鲲', '化鹏', '鲲鹏神'],
    fallback: ['🥚', '🐟', '🐠', '🦈', '🐋', '🦅'],
    color: '#10b981',
  },
  on: {
    name: '玄武', theme: '北方水神 · 龟蛇合体',
    stageNames: ['神卵', '灵龟', '玄龟', '蛇龟合', '千岁玄', '玄武神'],
    fallback: ['🥚', '🐚', '🐢', '🐍', '🌊', '🐉'],
    color: '#0284c7',
  },
  pl: {
    name: '白虎', theme: '西方金神 · 永镇长存',
    stageNames: ['虎卵', '幼虎', '猛虎', '金虎', '山君', '白虎神'],
    fallback: ['🥚', '🐈', '🐅', '🐆', '🐯', '👑'],
    color: '#e2e8f0',
  },
  sx: {
    name: '麒麟', theme: '仁兽至圣 · 现世太平',
    stageNames: ['麟卵', '幼麟', '花麟', '独角麟', '火麒', '麒麟神'],
    fallback: ['🥚', '🐐', '🦌', '🦄', '🔥', '👑'],
    color: '#eab308',
  },
  bg: {
    name: '饕餮', theme: '四凶之首 · 贪食万宝',
    stageNames: ['凶卵', '饕餮幼', '兽面纹', '青铜饕', '万宝食', '饕餮神'],
    fallback: ['🥚', '👺', '👹', '🗿', '💰', '👑'],
    color: '#f97316',
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
