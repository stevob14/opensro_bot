// ==UserScript==
// @name         OpenSRO Bot
// @namespace    http://127.0.0.1:5180/
// @version      1.2.79
// @updateURL    https://raw.githubusercontent.com/stevob14/opensro_bot/main/bot.user.js
// @downloadURL  https://raw.githubusercontent.com/stevob14/opensro_bot/main/bot.user.js
// @description  Combat, reliable looting, potions, restocking and walk-back in one compact panel.
// @author       Adapted from TSK's OpenSRO Assistant
// @match        https://opensro.online/play*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// @noframes
// ==/UserScript==

(function () {
'use strict';
const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
if (W.__SRO_ASISTAN__ || W.__SRO_LEAN__) {
  console.warn('[OpenSRO Bot] Another SRO assistant is active. Disable it and reload to use OpenSRO Bot.');
  return;
}
const VERSION = '1.2.79';
const APP = { version: VERSION };
Object.defineProperty(W, '__SRO_LEAN__', { value: APP });
Object.defineProperty(W, '__SRO_ASISTAN__', { value: APP });
const T = (tr, en) => en ?? tr;


const now = () => performance.now();
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtInt(n) {
  if (!isNum(n)) return '-';
  return Math.round(n).toLocaleString('tr-TR');
}

function fmtBig(v) {
  try {
    return BigInt(v).toLocaleString('tr-TR');
  } catch {
    return String(v ?? '-');
  }
}

function fmtDuration(ms) {
  if (!isNum(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function toBigInt(v) {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
}

function splitList(text) {
  return String(text || '')
    .split(/[,;\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base.slice();
  if (!base || typeof base !== 'object') return over === undefined ? base : over;
  const out = {};
  for (const k of Object.keys(base)) out[k] = deepMerge(base[k], over ? over[k] : undefined);
  if (over && typeof over === 'object') {
    for (const k of Object.keys(over)) if (!(k in base)) out[k] = over[k];
  }
  return out;
}

function debounce(fn, ms) {
  let t = 0;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

class Emitter {
  constructor() {
    this.map = new Map();
  }
  on(ev, fn) {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev).add(fn);
    return () => this.map.get(ev)?.delete(fn);
  }
  emit(ev, ...args) {
    const set = this.map.get(ev);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (e) {
        console.error('[OpenSRO Bot]', ev, e);
      }
    }
  }
}

const bus = new Emitter();

// ---------------------------------------------------------------------------
// Log (kept in memory, shown in the Statistics > Log tab)
// ---------------------------------------------------------------------------

const Log = {
  lines: [],
  add(level, text) {
    const entry = { at: Date.now(), level, text: String(text) };
    this.lines.push(entry);
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
    if (level === 'error') console.warn('[OpenSRO Bot]', text);
    bus.emit('log', entry);
  },
  info(t) { this.add('info', t); },
  warn(t) { this.add('warn', t); },
  error(t) { this.add('error', t); },
  cmd(t) { this.add('cmd', t); },
};

// ---------------------------------------------------------------------------
// Persistent storage (localStorage, every access guarded)
// ---------------------------------------------------------------------------

const Store = {
  prefix: 'sroBotLean:v1:',
  get(key, def) {
    try {
      const raw = W.localStorage.getItem(this.prefix + key);
      return raw == null ? def : JSON.parse(raw);
    } catch {
      return def;
    }
  },
  set(key, value) {
    try {
      W.localStorage.setItem(this.prefix + key, JSON.stringify(value));
      return true;
    } catch (e) {
      Log.warn('Could not save settings: ' + e);
      return false;
    }
  },
  remove(key) {
    try {
      W.localStorage.removeItem(this.prefix + key);
    } catch {}
  },
  keys() {
    const out = [];
    try {
      for (let i = 0; i < W.localStorage.length; i++) {
        const k = W.localStorage.key(i);
        if (k && k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
      }
    } catch {}
    return out;
  },
};

const CLASS_KEYS = ['normal', 'champion', 'giant', 'party', 'elite', 'unique'];
const DEFAULT_PROFILE = {
  alchemy: { target: 3, limit: 20, elixir: 0, powder: false },
  mastery: { enabled: false, ids: [], gap: 0, skills: false, reserve: 0, order: 'masteries' },
  party: { autoAcceptMatching: false, autoRecruit: false, autoRes: false, acceptRes: false, resRadius: 300, title: 'Hunting party', min: 1, max: 90, purpose: 0, expShare: true, itemShare: true },
  wardrobe: { on: true, phantom: true, realAnim: true, hideAvatars: false,
    eq: {}, av: {}, pet: { atk: 0, pick: 0, mount: 0 }, presets: {}, undo: null },
  macro: {
    rotations: { normal: [], champion: [], giant: [], party: [], elite: [], unique: [] },
    fallbackToNormal: true, normalAttack: true, buffs: [], imbue: null, buffSwap: false, buffSets: [],
    imbueBeforeAttack: true, berserkClasses: { normal: false, champion: false, giant: true, party: false, elite: false, unique: false, titan: false },
    minMpPct: 0, castGapMs: 350,
  },
  potion: {
    enabled: true, speedScroll: false, hp: { on: true, pct: 60 }, mp: { on: true, pct: 40 },
    vigor: { on: true, hpPct: 30, mpPct: 15 }, cure: { on: true }, petHp: { on: false, pct: 50 },
    prefer: { hp: 0, mp: 0, vigor: 0, cure: 0 }, delayMs: 350,
    restock: {
      enabled: false, vendor: null, route: [], offers: [],
      town: { enabled: false, revive: true, storeSox: true, storeLevels: '', petFull: true, petFree: 1, arrivalRadius: 500, arrival: null, storage: null, vendor: null, smith: null, gate: null,
        keep: '', store: { equipment: true, elixirs: true, powders: true, alchemy: true, others: false } },
      hp: { on: true, refObjId: 0, low: 20, target: 100 },
      mp: { on: true, refObjId: 0, low: 20, target: 300 },
      cure: { on: false, refObjId: 58, low: 10, target: 50 },
      vigor: { on: false, refObjId: 22, low: 10, target: 50 },
    },
  },
  hunt: {
    center: null, radius: 400, chase: 700, returnToCenter: true,
    classes: { normal: true, champion: true, giant: true, party: false, elite: false, unique: false, titan: false },
    levelMin: 0, levelMax: 0, include: '', exclude: '', priority: 'attackers', avoidKs: true,
    targetTimeoutS: 25,
    pickup: { enabled: true, soxOnly: false, gold: true, potions: true, equipment: true, elixirs: true, powders: true, magicStones: true, attrStones: true, alchemy: true, others: true,
      collector: 'character', petFullSound: true, soxSound: true, include: '', exclude: '', radius: 300, afterKillOnly: true, retries: 2 },
    sit: { enabled: true, hpBelow: 35, mpBelow: 20, resumeAt: 90 },
    antiStuck: { enabled: true, minutes: 3, maxRecoveries: 3 },
    onDeath: 'stop', stopNoHpPotion: false, stopInvFull: false,
    playerAlert: { enabled: false, radius: 250, pause: false }, manualPauseS: 6,
  },
};
// Preserve only bot settings. The original assistant's settings are never changed.
function botProfile(input) {
  const result = deepMerge(DEFAULT_PROFILE, {});
  if (!input || typeof input !== 'object') return result;
  for (const key of ['macro', 'potion', 'hunt', 'wardrobe', 'party', 'alchemy', 'mastery']) {
    if (!input[key] || typeof input[key] !== 'object') continue;
    for (const field of Object.keys(DEFAULT_PROFILE[key])) {
      if (field in input[key]) result[key][field] = deepMerge(DEFAULT_PROFILE[key][field], input[key][field]);
    }
  }
  // Migrate the old separate town stack targets once. Preserve the active
  // return mode's target; walking-only profiles retain their refill quantities.
  const restock = input.potion?.restock;
  if (restock?.town?.enabled && restock.town.stacks) {
    for (const kind of ['hp', 'mp']) {
      const stacks = restock.town.stacks[kind];
      if (Number.isInteger(stacks) && stacks >= 1 && stacks <= 200) result.potion.restock[kind].target = stacks * 50;
    }
  }
  delete result.potion.restock.town.stacks;
  // New categories inherit the old Other items switch, preserving existing selection.
  const pickup = input.hunt?.pickup;
  for (const key of ['elixirs', 'powders', 'alchemy']) {
    if (pickup && !(key in pickup)) result.hunt.pickup[key] = pickup.others ?? true;
  }
  // The old Berserk dropdown: Off and Whenever full carry over; Champion and above becomes Giants only.
  const mode = input.macro?.berserk;
  if (!input.macro?.berserkClasses && (mode === 'off' || mode === 'always')) {
    for (const key of Object.keys(result.macro.berserkClasses)) result.macro.berserkClasses[key] = mode === 'always';
  }
  // Magic and attribute stones used to sit in the alchemy switch, so they keep its setting.
  for (const key of ['magicStones', 'attrStones']) {
    if (pickup && !(key in pickup)) result.hunt.pickup[key] = pickup.alchemy ?? pickup.others ?? true;
  }
  return result;
}
const Settings = {
  profileKey: 'profile:default',
  profile: botProfile(Store.get('profile:default', null)),
  saveProfile: debounce(() => Store.set(Settings.profileKey, Settings.profile), 250),
  useCharacter(name) {
    const key = name ? 'profile:' + name : 'profile:default';
    if (key === this.profileKey) return;
    Store.set(this.profileKey, this.profile);
    this.profileKey = key;
    this.profile = botProfile(Store.get(key, null));
    bus.emit('profile');
  },
  importOriginal() {
    try {
      const raw = W.localStorage.getItem('sroAsistan:v7:' + this.profileKey)
        || W.localStorage.getItem('sroAsistan:v7:profile:default');
      if (!raw) return UI.toast('No original bot profile was found.', 'warn');
      stopAll();
      this.profile = botProfile(JSON.parse(raw));
      // The improved loot controller defaults to finishing its fight first.
      this.profile.hunt.pickup.afterKillOnly = true;
      this.saveProfile();
      bus.emit('profile');
      UI.toast('Imported combat, potion and hunting settings. Review them before starting.');
    } catch (e) { UI.toast('Could not import profile: ' + e.message, 'warn'); }
  },
};
const Sound = {
  ctx: null,
  unlock() {
    try {
      this.ctx ||= new (W.AudioContext || W.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {}
  },
  // Only these alerts are audible; existing combat/UI calls stay silent.
  tones: { 'pet-full': { notes: [659.25, 830.61, 987.77], gap: 0.18 }, sox: { notes: [783.99, 987.77, 1174.66, 1567.98], gap: 0.11 } },
  play(kind) {
    const tone = this.tones[kind];
    if (!tone) return false;
    try {
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') return false;
      tone.notes.forEach((frequency, i) => {
        const oscillator = ctx.createOscillator(), gain = ctx.createGain();
        const at = ctx.currentTime + i * tone.gap;
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.12, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
        oscillator.connect(gain); gain.connect(ctx.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(at); oscillator.stop(at + 0.6);
      });
      return true;
    } catch { return false; }
  },
  async test(kind = 'pet-full') {
    this.unlock();
    try { if (this.ctx?.state === 'suspended') await this.ctx.resume(); } catch {}
    if (!this.play(kind)) UI.toast('Sound is blocked by the browser. Allow audio for this site and try again.', 'warn');
  },
};


const SECTOR = 1920;
const DUNGEON = 0x8000;

function regionDelta(a, b) {
  if ((a.regionId | b.regionId) & DUNGEON) {
    if (a.regionId !== b.regionId) return null;
    return [b.x - a.x, b.z - a.z];
  }
  return [
    b.x - a.x + ((b.regionId & 255) - (a.regionId & 255)) * SECTOR,
    b.z - a.z + ((b.regionId >>> 8) - (a.regionId >>> 8)) * SECTOR,
  ];
}

function dist2D(a, b) {
  if (!a || !b) return Infinity;
  const d = regionDelta(a, b);
  return d ? Math.hypot(d[0], d[1]) : Infinity;
}

// Same formula as the game's minimap coordinate read-out (X/Y in the HUD).
function displayCoords(p) {
  if (!p) return null;
  // The game leaves the read-out empty in dungeons; local units are shown instead.
  if (p.regionId & DUNGEON) return { x: Math.trunc(p.x / 10), y: Math.trunc(p.z / 10), dungeon: true };
  return {
    x: ((p.regionId & 255) - 135) * 192 + Math.trunc(p.x / 10),
    y: ((p.regionId >>> 8) - 92) * 192 + Math.trunc(p.z / 10),
  };
}

// Monster grade, from the spawn byte (rarity = low nibble, party icon = high nibble).
const RARITY = { 0: 'normal', 1: 'champion', 3: 'unique', 4: 'giant', 5: 'titan', 6: 'elite' };
const RARITY_HP = { normal: 1, champion: 2, unique: 1, giant: 20, titan: 100, elite: 4 };

function monsterClass(e) {
  if (!e) return 'normal';
  if (e.rarityAuxIcon === 1) return 'party';
  return RARITY[e.rarity ?? 0] || 'normal';
}

function rotationKey(cls) {
  return cls === 'titan' ? 'unique' : cls;
}

function isFrostNovaIceField(skill) {
  const info = typeof skill === 'number' ? World.skill(skill) : skill;
  if (!info) return false;
  return /frost\s*nova.*ice\s*field/i.test(info.name || '')
    || /^(?:SN_)?SKILL_CH_COLD_BINGPAN_D$/i.test(info.name || '')
    || info.nameSymbol === 'SN_SKILL_CH_COLD_BINGPAN_D'
    || /(?:^|[\\/])cold_bingpan_d\.ddj$/i.test(info.icon || '')
    || [19515, 19516, 19517].includes(info.id);
}

function effectiveMaxHp(e) {
  if (!e || !isNum(e.maxHp)) return undefined;
  const base = RARITY_HP[RARITY[e.rarity ?? 0] || 'normal'] ?? 1;
  return e.maxHp * base * (e.rarityAuxIcon === 1 ? 10 : 1);
}

// Item type words (typeFlags / tidWord): TID1 = (tf>>2)&7, TID2 = (tf>>5)&3,
// TID3 = (tf>>7)&15, TID4 = tf>>>11.
const ItemType = {
  isPotion: (tf) => (tf & 2046) === 236,
  potionCategory: (tf) => ((tf & 2046) === 236 ? tf >>> 11 : 0), // 1 HP, 2 MP, 3 vigor (4/5/7/9: companion)
  // TID4 7 is the companion cure; the worker makes it target an owned COS (worker ll()).
  isCure: (tf) => (tf & 2046) === 364 && tf >>> 11 !== 7,
  // Extra target an "item-use" needs, mirroring the simulation worker's ll():
  // 'revival' = companion revival scroll (TID3 1 / TID4 6) -> one dead companion's summoner item,
  // 'summoner' = TID3 13 / TID4 12 -> one pickup companion's summoner item,
  // 'companion' = companion potion / cure (TID3 1 & TID4 4,5,7,9 or TID3 2 & TID4 7) -> one living own COS.
  useTarget(tf) {
    if ((tf & 28) !== 12 || ((tf >>> 5) & 3) !== 3) return '';
    const t3 = (tf >>> 7) & 15;
    const t4 = (tf >>> 11) & 31;
    if (t3 === 1 && t4 === 6) return 'revival';
    if (t3 === 13 && t4 === 12) return 'summoner';
    if ((t3 === 1 && [4, 5, 7, 9].includes(t4)) || (t3 === 2 && t4 === 7)) return 'companion';
    return '';
  },
  isReturnScroll: (tf) => !(tf & 2) && (tf & 28) === 12 && (tf & 96) === 96 && (tf & 1920) === 384 && [1, 3].includes(tf >>> 11),
  isGold: (tf) => (tf & 96) === 96 && (tf & 1920) === 640,
  isEquipment: (tf) => (tf & 126) === 44,
  isStackable: (tf) => (tf & 126) === 108,
};

// Abnormal (status) bits as named by the client. Bit 5 (zombie) is excluded from
// curing, matching the client's own auto potion rules.
const ABNORMAL_NAMES = {
  0: 'Freeze', 1: 'Frostbite', 2: 'Shock', 3: 'Burn', 4: 'Poison', 5: 'Zombie', 6: 'Sleep', 7: 'Bind',
  8: 'Slow', 9: 'Fear', 10: 'Dull', 11: 'Bleed', 13: 'Darkness', 14: 'Stun', 15: 'Disease',
  16: 'Confusion', 17: 'Decay', 18: 'Weaken', 19: 'Impotent', 20: 'Division', 21: 'Panic', 22: 'Combustion', 24: 'Hidden',
};
const CURABLE_MASK = ~(1 << 5) >>> 0;

const Hook = {
  sim: null,
  late: false,
  post: null, // native postMessage bound to the simulation worker
  nativePost: null,
  NativeWorker: null,
  simUrl: '',
  observers: [],
  guards: [], // fn(command) -> true swallows one of the game's own commands
  probe: null,
};

function attachSimulation(worker, late) {
  if (Hook.sim) return;
  Hook.sim = worker;
  Hook.late = late;
  const nativePost = Hook.nativePost || W.Worker.prototype.postMessage;
  Hook.post = (msg) => nativePost.call(worker, msg);
  worker.addEventListener('message', onSimulationMessage);
  // Observe the game's own outgoing commands (manual play detection).
  try {
    const own = worker.postMessage;
    worker.postMessage = function (msg, transfer) {
      if (msg && msg.kind === 'session' && msg.command) {
        // Probe mode (see Probe.at): record what the game would send and swallow it.
        if (Hook.probe) {
          Hook.probe.push(msg.command);
          const inner = msg.command.command;
          return undefined;
          for (const g of Hook.guards) {
            try {
              if (g(msg.command)) return undefined;
            } catch {}
          }
        } else {
          for (const g of Hook.guards) {
            try {
              if (g(msg.command)) return undefined;
            } catch {}
          }
          for (const fn of Hook.observers) {
            try { fn(msg.command); } catch {}
          }
        }
      }
      return own.apply(this, arguments);
    };
  } catch (e) {
    Log.warn('Command observer could not be installed: ' + e);
  }
  Log.info(late ? 'The game was already running: attached late (some data arrives on the first change).' : 'Attached to the game worker.');
  bus.emit('attached', { late });
}

function installWorkerHook() {
  const Native = W.Worker;
  if (typeof Native !== 'function' || Native.__sroAsistanHooked) return;
  const nativePost = Native.prototype.postMessage;
  Hook.nativePost = nativePost;
  Hook.NativeWorker = Native;

  class Worker extends Native {
    constructor(url, options) {
      super(url, options);
      try {
        const name = options && options.name;
        if (name === 'sro-simulation') {
          Hook.simUrl = String(url);
          attachSimulation(this, false);
        }
      } catch (e) {
        console.error('[OpenSRO Bot] hook', e);
      }
    }
  }
  Object.defineProperty(Worker, '__sroAsistanHooked', { value: true });
  W.Worker = Worker;

  // Late attach: the simulation worker is the only one that receives these kinds.
  const SIM_KINDS = new Set(['world-ack', 'input', 'session', 'recycle']);
  Native.prototype.postMessage = function (msg) {
    if (!Hook.sim && msg && typeof msg === 'object' && SIM_KINDS.has(msg.kind)) {
      Native.prototype.postMessage = nativePost;
      attachSimulation(this, true);
    }
    return nativePost.apply(this, arguments);
  };
  bus.on('attached', () => {
    if (Native.prototype.postMessage !== nativePost) Native.prototype.postMessage = nativePost;
  });
}

function onSimulationMessage(e) {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  try {
    if (d.kind === 'snapshot' || (d.buffer instanceof ArrayBuffer && d.buffer.byteLength === 32 && !d.kind)) {
      World.onSnapshot(d.buffer);
    } else if (d.kind === 'world' && d.batch) {
      World.applyBatch(d.batch);
    } else if (d.kind === 'session' && d.state) {
      World.applySession(d.state);
    } else if (d.kind === 'failure') {
      World.failure = String(d.message || 'failure');
      Log.error('The game simulation stopped: ' + World.failure);
      bus.emit('failure', World.failure);
    }
  } catch (err) {
    Log.error('Could not process data: ' + (err && err.message ? err.message : err));
  }
}

const Display = {
  rewriters: [],
  add(name, fn) {
    this.rewriters.push({ name, fn });
  },
  apply(entity) {
    return this.run(this.rewriters, entity);
  },

  // Same for the 'gameplay' event state (the local player's own equipment look comes
  // from gameplay.inventory slots 0..8). The game copies the state shallowly
  // ({...state}), so arrays handed over here stay shared with it: a rewriter may keep
  // a reference to an array it created and change it in place later; the game picks
  // that up on its next frame without waiting for a new event.
  gameplayRewriters: [],
  addGameplay(name, fn) {
    this.gameplayRewriters.push({ name, fn });
  },
  applyGameplay(state) {
    return this.run(this.gameplayRewriters, state);
  },

  run(list, value) {
    let out = value;
    for (const r of list) {
      try {
        const next = r.fn(out, value);
        if (next && typeof next === 'object') out = next;
      } catch (e) {
        Log.warn('Display rewriter error (' + r.name + '): ' + ((e && e.message) || e));
      }
    }
    return out;
  },
};

const TRANSIENT_PHASES = new Set(['entering-world', 'reconnecting', 'connecting']);

const World = {
  session: null,
  phase: 'signed-out',
  failure: null,
  epoch: 0,
  ents: new Map(),
  gp: null,
  catalog: new Map(), // skill id -> catalog entry
  groups: new Map(), // skill group -> [entries sorted by level]
  charName: '',
  simOffset: null,
  berserkGauge: 0,
  hpSeen: new Map(), // gid -> hp from hp-seed / hp-refresh
  attackers: new Map(), // monster gid -> sim ms it last hit us
  hitByOthers: new Map(), // monster gid -> sim ms another player hit it
  hitByUs: new Map(), // monster gid -> sim ms we hit it
  lastSeq: { notice: 0, chat: 0, gm: 0 },
  dirty: { ents: false, gp: false },
  batches: 0,

  onSnapshot(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 16) return;
    const sim = new DataView(buf).getFloat64(8, true);
    if (isNum(sim)) this.simOffset = sim - now();
  },

  simNow() {
    return this.simOffset == null ? null : now() + this.simOffset;
  },

  applySession(state) {
    const prevPhase = this.phase;
    this.session = state;
    this.phase = state.phase || this.phase;
    if (typeof state.character === 'string' && state.character && state.character !== this.charName) {
      this.charName = state.character;
      bus.emit('character', this.charName);
    }
    if (prevPhase !== this.phase) {
      // Teleports and short reconnects pass through these phases and come back to
      // "world"; only other phases mean the player really left the game world.
      if (this.phase === 'world') this.inWorldSession = true;
      const left = !!this.inWorldSession && this.phase !== 'world' && !TRANSIENT_PHASES.has(this.phase);
      if (left) {
        this.inWorldSession = false;
        this.gp = null;
      }
      if (this.phase !== 'world') this.resetWorld();
      bus.emit('phase', this.phase, prevPhase, left);
    }
  },

  resetWorld() {
    this.ents.clear();
    this.hpSeen.clear();
    this.attackers.clear();
    this.hitByOthers.clear();
    this.hitByUs.clear();
    this.dirty.ents = true;
  },

  applyBatch(batch) {
    this.batches++;
    for (const ev of batch.events || []) this.applyEvent(ev);
    if (this.dirty.ents || this.dirty.gp) {
      const flags = { ents: this.dirty.ents, gp: this.dirty.gp };
      this.dirty.ents = this.dirty.gp = false;
      bus.emit('world', flags);
    }
  },

  applyEvent(ev) {
    switch (ev.kind) {
      case 'spawn':
      case 'state':
        if (ev.entity && ev.entity.gid) {
          const real = ev.entity;
          const prev = this.ents.get(real.gid);
          this.ents.set(real.gid, real);
          this.dirty.ents = true;
          // The game gets the display copy; the mirror and every listener keep the real entity.
          if (Display.rewriters.length) ev.entity = Display.apply(real);
          if (ev.kind === 'spawn') bus.emit('spawn', real);
          else if (prev && prev.appearanceState?.[0] !== 2 && real.appearanceState?.[0] === 2) bus.emit('death', real);
        }
        break;
      case 'despawn': {
        const e = this.ents.get(ev.gid);
        this.ents.delete(ev.gid);
        this.hpSeen.delete(ev.gid);
        this.attackers.delete(ev.gid);
        this.hitByOthers.delete(ev.gid);
        this.hitByUs.delete(ev.gid);
        this.dirty.ents = true;
        if (e) bus.emit('despawn', e);
        break;
      }
      case 'reset':
        this.epoch = ev.epoch ?? this.epoch + 1;
        this.resetWorld();
        bus.emit('reset');
        break;
      case 'bootstrap':
        if (ev.value?.character?.name) {
          this.charName = ev.value.character.name;
          bus.emit('character', this.charName);
        }
        break;
      case 'gameplay':
        if (ev.state) {
          this.applyGameplay(ev.state);
          if (Display.gameplayRewriters.length) ev.state = Display.applyGameplay(ev.state);
        }
        break;
      case 'hp-seed':
      case 'hp-refresh':
        if (isNum(ev.hp)) this.hpSeen.set(ev.gid, ev.hp);
        break;
      case 'hp-revive':
        this.hpSeen.delete(ev.gid);
        break;
      case 'orb-gauge':
        if (isNum(ev.value)) {
          this.berserkGauge = ev.value;
          bus.emit('berserk', ev.value);
        }
        break;
      case 'cast-finalize':
        if (ev.cast) this.onCast(ev.cast);
        break;
      case 'level-up':
        if (ev.gid && ev.gid === this.gp?.localGid) bus.emit('levelup');
        break;
      case 'travel':
        bus.emit('travel', ev.travel);
        break;
      default:
        break;
    }
  },

  onCast(cast) {
    const local = this.gp?.localGid;
    const t = this.simNow() ?? now();
    const targets = new Set();
    if (cast.target) targets.add(cast.target);
    for (const r of cast.results || []) if (r && r.target) targets.add(r.target);
    const caster = this.ents.get(cast.caster);
    if (cast.caster === local) {
      for (const gid of targets) this.hitByUs.set(gid, t);
    } else if (caster && caster.kind === 'monster' && local && targets.has(local)) {
      this.attackers.set(cast.caster, t);
    } else if (caster && (caster.kind === 'player' || caster.kind === 'cos')) {
      for (const gid of targets) {
        if (caster.kind === 'cos' && caster.ownerGid === local) continue;
        const target = this.ents.get(gid);
        if (target && target.kind === 'monster') this.hitByOthers.set(gid, t);
      }
    }
    bus.emit('cast', cast);
  },

  applyGameplay(state) {
    const prev = this.gp;
    const merged = {
      ...state,
      skillCatalog: state.skillCatalog ?? prev?.skillCatalog ?? null,
      social: state.social ?? prev?.social,
      shop: 'shop' in state ? state.shop : prev?.shop,
    };
    this.gp = merged;
    this.dirty.gp = true;
    if (state.skillCatalog) this.rebuildCatalog(state.skillCatalog);

    for (const n of merged.notices || []) {
      if (isNum(n.sequence) && n.sequence > this.lastSeq.notice) {
        this.lastSeq.notice = n.sequence;
        if (prev) bus.emit('notice', n);
      }
    }
    for (const line of merged.chat?.lines || []) {
      if (isNum(line.sequence) && line.sequence > this.lastSeq.chat) {
        this.lastSeq.chat = line.sequence;
        if (prev) bus.emit('chat', line);
      }
    }
    for (const r of merged.gmReplies || []) {
      if (isNum(r.sequence) && r.sequence > this.lastSeq.gm) {
        this.lastSeq.gm = r.sequence;
        if (prev) bus.emit('gm-reply', r);
      }
    }
    if (prev && prev.error !== merged.error && merged.error) bus.emit('game-error', merged.error);
    bus.emit('gameplay', merged, prev);
  },

  rebuildCatalog(list) {
    this.catalog.clear();
    this.groups.clear();
    for (const s of list) {
      if (!s || !isNum(s.id)) continue;
      this.catalog.set(s.id, s);
      const g = s.group ?? s.groupId ?? s.id;
      if (!this.groups.has(g)) this.groups.set(g, []);
      this.groups.get(g).push(s);
    }
    for (const arr of this.groups.values()) arr.sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    bus.emit('catalog');
  },

  // ---- state queries ------------------------------------------------------

  inWorld() {
    return !!(this.gp && this.gp.localGid && this.phase === 'world' && !this.failure);
  },
  localGid() {
    return this.gp?.localGid || 0;
  },
  local() {
    return this.ents.get(this.localGid());
  },
  pose() {
    const p = this.gp?.pose;
    if (p && isNum(p.x)) return p;
    const l = this.local();
    return l ? { regionId: l.regionId, x: l.x, y: l.y, z: l.z, angle: l.heading ?? 0 } : null;
  },
  vitalsOf(gid) {
    return this.gp?.vitals?.find((v) => v.gid === gid);
  },
  me() {
    const v = this.vitalsOf(this.localGid()) || {};
    const stats = this.gp?.progression?.stats || {};
    const maxHp = v.maxHp || stats.maxHp || 0;
    const maxMp = v.maxMp || stats.maxMp || 0;
    const hp = isNum(v.hp) ? v.hp : maxHp;
    const mp = isNum(v.mp) ? v.mp : maxMp;
    return {
      hp, mp, maxHp, maxMp,
      hpPct: maxHp ? (hp / maxHp) * 100 : 100,
      mpPct: maxMp ? (mp / maxMp) * 100 : 100,
      abnormal: (v.abnormal ?? 0) >>> 0,
    };
  },
  isDead() {
    const l = this.local();
    if (l && l.appearanceState?.[0] === 2) return true;
    const v = this.vitalsOf(this.localGid());
    return !!(v && v.hp === 0 && v.maxHp > 0);
  },
  isSitting() {
    return this.local()?.movementMode === 4;
  },
  isAlive(e) {
    return !!e && e.appearanceState?.[0] !== 2 && this.hpOf(e.gid) !== 0;
  },
  hpOf(gid) {
    const v = this.vitalsOf(gid);
    if (v && isNum(v.hp)) return v.hp;
    return this.hpSeen.get(gid);
  },
  hpPctOf(e) {
    const hp = this.hpOf(e.gid);
    const max = this.vitalsOf(e.gid)?.maxHp || effectiveMaxHp(e);
    if (!isNum(hp) || !max) return null;
    return clamp((hp / max) * 100, 0, 100);
  },
  target() {
    const gid = this.gp?.target;
    return gid ? this.ents.get(gid) : null;
  },
  distTo(e) {
    return dist2D(this.pose(), e);
  },
  freeBagSlots() {
    const gp = this.gp;
    if (!gp) return null;
    const total = gp.inventorySlotCount || 0;
    const equip = gp.equipmentSlotCount || 13;
    const used = new Set((gp.inventory || []).filter((i) => i.slot >= equip).map((i) => i.slot));
    return Math.max(0, total - equip - used.size);
  },
  items() {
    const equip = this.gp?.equipmentSlotCount || 13;
    return (this.gp?.inventory || []).filter((i) => i.slot >= equip);
  },

  // ---- skills -------------------------------------------------------------

  skill(id) {
    return this.catalog.get(id);
  },
  learned(id) {
    return !!this.gp?.skills?.includes(id);
  },
  skillName(id) {
    return this.catalog.get(id)?.name || '#' + id;
  },
  // Highest learned level of a skill group (skills are stored by group so that a
  // rotation keeps working after the skill is levelled up).
  bestOfGroup(group, fallbackId) {
    const arr = this.groups.get(group);
    if (arr) {
      for (let i = arr.length - 1; i >= 0; i--) if (this.learned(arr[i].id)) return arr[i].id;
    }
    return fallbackId && this.learned(fallbackId) ? fallbackId : 0;
  },
  cooldownLeft(id) {
    const list = this.gp?.skillCooldowns;
    const t = this.simNow();
    if (!list || !list.length || t == null) return 0;
    const group = this.catalog.get(id)?.cooldownGroup ?? 0;
    let left = 0;
    for (const c of list) {
      if (c.skill === id || (group && c.group === group)) left = Math.max(left, c.startedAtMs + c.durationMs - t);
    }
    return left;
  },
  itemCooldownLeft(category) {
    const list = this.gp?.itemCooldowns;
    const t = this.simNow();
    if (!list || !list.length || t == null) return 0;
    let left = 0;
    for (const c of list) if (c.category === category) left = Math.max(left, c.startedAtMs + c.durationMs - t);
    return left;
  },
  // Own cast that has not produced its result yet.
  isCasting() {
    const local = this.localGid();
    const t = this.simNow();
    for (const c of this.gp?.casts || []) {
      if (c.caster !== local || c.cancelledAtMs !== undefined || c.resultOnly) continue;
      if (t != null && isNum(c.receivedAtMs) && t - c.receivedAtMs > 6000) continue;
      if (!c.results || !c.results.length) return true;
    }
    return false;
  },
  buffRemaining(skillId) {
    const local = this.localGid();
    const group = this.catalog.get(skillId)?.group;
    const t = this.simNow();
    let best = -1;
    const match = (sid) => sid === skillId || (group !== undefined && this.catalog.get(sid)?.group === group);
    for (const b of this.gp?.buffSlots || []) {
      const ef = b.effect;
      if (!ef || b.state === 'departing' || ef.gid !== local || !match(ef.skill)) continue;
      let rem = Infinity;
      if (isNum(ef.remainingMs) && isNum(ef.receivedAtMs) && t != null) rem = ef.remainingMs - (t - ef.receivedAtMs);
      best = Math.max(best, rem);
    }
    if (best < 0) {
      for (const ef of this.gp?.attachedEffects || []) {
        if (ef.gid === local && match(ef.skill)) best = Math.max(best, Infinity);
      }
    }
    return best; // -1 = not active
  },
};

const MIN_GAP = {
  select: 220,
  attack: 700,
  'cos-attack': 700,
  skill: 120,
  pickup: 350,
  move: 550,
  'item-use': 220,
  'action-command': 700,
  berserk: 1500,
  'release-target': 600,
  rebirth: 3000,
};

const Cmd = {
  last: {},
  sent: 0,
  history: [],
  lastError: '',

  ready() {
    return !!Hook.post && World.inWorld();
  },

  spaced(kind) {
    const gap = MIN_GAP[kind] ?? 200;
    return now() - (this.last[kind] ?? -Infinity) >= gap;
  },

  raw(command, label) {
    if (!this.ready()) return false;
    // Same rule as the game's own commands (Hook.guards), e.g. no target on a revealed hidden player.
    const wrapped = { kind: 'gameplay', command };
    for (const g of Hook.guards) {
      try {
        if (g(wrapped)) return false;
      } catch {}
    }
    try {
      Hook.post({ kind: 'session', command: { kind: 'gameplay', command } });
    } catch (e) {
      Log.error('Command could not be sent: ' + e);
      return false;
    }
    this.last[command.kind] = now();
    this.sent++;
    const text = label || command.kind;
    this.history.push({ at: Date.now(), text });
    if (this.history.length > 200) this.history.shift();
    Log.cmd(text);
    bus.emit('command', command);
    return true;
  },

  entity(gid) {
    return gid ? World.ents.get(gid) : undefined;
  },

  select(gid) {
    const gp = World.gp;
    const e = this.entity(gid);
    if (!gp || !e || e.kind === 'ground-item' || gid === gp.localGid) return false;
    if (gp.target === gid) return true;
    if (gp.targetPending || !this.spaced('select')) return false;
    return this.raw({ kind: 'select', gid }, `Select: ${e.name || gid}`);
  },

  attack(gid) {
    const e = this.entity(gid);
    if (!e || e.kind !== 'monster' || !World.isAlive(e) || World.isDead()) return false;
    const kind = World.local()?.mountedOn ? 'cos-attack' : 'attack';
    if (!this.spaced(kind)) return false;
    return this.raw({ kind, gid }, `Attack: ${e.name || gid}`);
  },

  // A skill can be cast when it is learned, not cooling down and (for targeted
  // skills) when the target is the selected or pending-selected entity, because
  // the worker always replaces the gid with its own skill target.
  canCast(id) {
    if (!id || !World.learned(id) || World.isDead()) return false;
    const info = World.skill(id);
    if ((info?.groundTarget || isFrostNovaIceField(id)) && !isFrostNovaIceField(id)) return false;
    return World.cooldownLeft(id) <= 0;
  },

  groundSkillQuery(position) {
    if (!position || !Number.isInteger(position.regionId) || ![position.x, position.y, position.z].every(Number.isFinite)) return null;
    const rayHeight = 400;
    return {
      originRegion: position.regionId,
      ray: { start: [position.x, position.y + rayHeight, position.z], delta: [0, -rayHeight, 0] },
      terrainDepth: null,
    };
  },

  skill(id, gid) {
    if (!this.canCast(id) || !this.spaced('skill')) return false;
    const info = World.skill(id);
    const cmd = { kind: 'skill', skillId: id };
    if (info?.groundTarget || isFrostNovaIceField(id)) {
      if (!isFrostNovaIceField(id)) return false;
      const gp = World.gp;
      const target = gid || gp?.target;
      const e = target ? this.entity(target) : null;
      if (!e || e.kind !== 'monster' || !World.isAlive(e)) return false;
      cmd.query = this.groundSkillQuery(e);
      if (!cmd.query) return false;
    } else if (!info || info.targetRequired) {
      const gp = World.gp;
      const target = gid || gp?.target;
      if (!target) return false;
      const e = this.entity(target);
      if (!e || !World.isAlive(e) && !(info?.targets & 128)) return false;
      cmd.gid = target;
    }
    return this.raw(cmd, `Skill: ${World.skillName(id)}`);
  },

  pickup(gid) {
    const e = this.entity(gid);
    if (!e || e.kind !== 'ground-item' || World.isDead() || !this.spaced('pickup')) return false;
    return this.raw({ kind: 'pickup', gid }, `Pick up: ${e.name || gid}`);
  },

  move(dest) {
    if (!dest || World.isDead() || !this.spaced('move')) return false;
    const gp = World.gp;
    if ((gp?.pendingMoves?.length ?? gp?.pendingMoves ?? 0) > 24) return false;
    const regionId = dest.regionId | 0;
    const x = Math.trunc(dest.x);
    const z = Math.trunc(dest.z);
    const y = Math.trunc(dest.y ?? World.pose()?.y ?? 0);
    if (regionId < 1 || regionId > 65535) return false;
    if (!(regionId & DUNGEON) && (x < 0 || x >= SECTOR || z < 0 || z >= SECTOR)) return false;
    if (Math.abs(y) > 32767 || Math.abs(x) > 32767 || Math.abs(z) > 32767) return false;
    const angle = clamp((dest.angle ?? World.pose()?.angle ?? 0) | 0, 0, 65535);
    return this.raw({ kind: 'move', destination: { regionId, x, y, z, angle } }, 'Move');
  },

  itemUse(slot) {
    const gp = World.gp;
    const item = gp?.inventory?.find(i => i.slot === slot);
    if (!item || gp.inventoryPending || World.isDead() || !this.spaced('item-use') || ItemType.useTarget(item.typeFlags)) return false;
    return this.raw({ kind: 'item-use', slot }, 'Use: ' + (item.name || item.refObjId));
  },

  action(id) {
    if (!this.spaced('action-command') || World.isDead()) return false;
    return this.raw({ kind: 'action-command', id }, `Action ${id}`);
  },

  berserk() {
    if (World.berserkGauge < 5 || World.isDead() || !this.spaced('berserk')) return false;
    return this.raw({ kind: 'berserk' }, 'Berserk');
  },

  release() {
    if (!World.gp?.target || World.gp.targetPending || !this.spaced('release-target')) return false;
    return this.raw({ kind: 'release-target' }, 'Release target');
  },

  rebirth(choice) {
    const local = World.local();
    if (!local || local.appearanceState?.[0] !== 2 || !this.spaced('rebirth')) return false;
    return this.raw({ kind: 'rebirth', choice }, choice === 1 ? 'Revive (return point)' : 'Revive');
  },
};

// Detect manual play: when the player clicks to move, attack or select by hand
// the hunt engine yields for a few seconds instead of fighting the player.
// Our own commands use the native postMessage directly, so only the game's
// commands pass through this observer.
const Manual = { lastAt: 0, kind: "" };
Hook.observers.push((command) => {
  if (command.kind !== "gameplay" || !command.command) return;
  const k = command.command.kind;
  if (["ground-move", "move", "select", "attack", "skill", "pickup", "cos-attack"].includes(k)) {
    Manual.lastAt = now();
    Manual.kind = k;
  }
});

const Ticker = {
  worker: null,
  timer: 0,
  start(fn, ms) {
    let ticked = false;
    // Plain timer when the worker cannot start or never ticks (e.g. Blob workers blocked).
    const fallback = (why) => {
      if (this.timer) return;
      try {
        this.worker?.terminate();
      } catch {}
      this.worker = null;
      this.timer = setInterval(fn, ms);
      Log.warn('Timer worker unavailable (' + why + '); switched to the page timer.');
    };
    try {
      const src = 'let t=0;onmessage=e=>{clearInterval(t);t=setInterval(()=>postMessage(0),e.data)}';
      this.worker = new (Hook.NativeWorker || W.Worker)(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { name: 'sro-asistan-ticker' });
      this.worker.onmessage = (e) => {
        ticked = true;
        fn(e);
      };
      this.worker.onerror = (e) => fallback((e && e.message) || 'error');
      this.worker.postMessage(ms);
      setTimeout(() => ticked || fallback('no response'), Math.max(4000, ms * 8));
    } catch (e) {
      fallback(String((e && e.message) || e));
    }
  },
};

const Potion = {
  lastUse: 0,
  lock: {},
  warned: {},

  score(item, kind, me) {
    const f = item.tooltip?.fields || {};
    const hp = (Number(f.itemParam1_29c) || 0) + (me.maxHp * (Number(f.itemParam2_2a0) || 0)) / 100;
    const mp = (Number(f.itemParam3_2a4) || 0) + (me.maxMp * (Number(f.itemParam4_2a8) || 0)) / 100;
    if (kind === 'hp') return hp;
    if (kind === 'mp') return mp;
    return hp + mp;
  },

  candidates(kind) {
    const cat = { hp: 1, mp: 2, vigor: 3 }[kind];
    return World.items().filter((i) => (kind === 'cure' ? ItemType.isCure(i.typeFlags) : ItemType.potionCategory(i.typeFlags) === cat) && (i.quantity ?? 1) > 0);
  },

  pick(kind) {
    const list = this.candidates(kind);
    if (!list.length) return null;
    const pref = Settings.profile.potion.prefer[kind];
    if (pref) {
      const p = list.find((i) => i.refObjId === pref);
      if (p) return p;
    }
    const me = World.me();
    return list.sort((a, b) => this.score(b, kind, me) - this.score(a, kind, me))[0];
  },

  count(kind) {
    return this.candidates(kind).reduce((n, i) => n + (i.quantity ?? 1), 0);
  },

  use(kind) {
    const cat = { hp: 1, mp: 2, vigor: 3, cure: 4 }[kind];
    if ((this.lock[cat] || 0) > now()) return false;
    if (cat <= 3 && World.itemCooldownLeft(cat) > 0) return false;
    const item = this.pick(kind);
    if (!item) {
      if (!this.warned[kind] || now() - this.warned[kind] > 60000) {
        this.warned[kind] = now();
        bus.emit('potion-empty', kind);
      }
      return false;
    }
    if (!Cmd.itemUse(item.slot)) return false;
    this.lastUse = now();
    this.lock[cat] = now() + 900;
    Stats.potion(item);
    return true;
  },

  tick() {
    const P = Settings.profile.potion;
    if (!P.enabled || !World.inWorld() || World.isDead()) return;
    if (now() - this.lastUse < P.delayMs || World.gp.inventoryPending) return;
    const me = World.me();
    if (!me.maxHp) return;
    const zombie = me.abnormal & (1 << 5);
    if (P.hp.on && !zombie && me.hpPct <= P.hp.pct && this.use('hp')) return;
    if (P.mp.on && me.mpPct <= P.mp.pct && this.use('mp')) return;
    if (P.vigor.on && ((!zombie && me.hpPct <= P.vigor.hpPct) || me.mpPct <= P.vigor.mpPct) && this.use('vigor')) return;
    if (P.cure.on && me.abnormal & CURABLE_MASK && !(me.abnormal & (1 << 14))) this.use('cure');
  },
};

const isAttackableMob = (e) =>
  typeof World.isAttackable === 'function'
    ? World.isAttackable(e)
    : !!e && e.kind === 'monster' && World.isAlive(e) && e.appearanceState?.[0] !== 4 && ((e.attackFlags ?? 16) & 16) !== 0;

const Combat = {
  lastCastAt: 0,
  lastAttackAt: 0,
  buffCastAt: new Map(),
  buffSeen: new Set(),
  stuck: new Map(),
  lastCastId: 0,

  init() {
    bus.on('notice', (n) => {
      if (/SKILL_?USE_FAIL/.test(String(n?.key || '')) && this.lastCastId && now() - this.lastCastAt < 2000) this.fail(this.lastCastId);
    });
    bus.on('cast', (c) => {
      if (c.caster === World.localGid()) this.stuck.delete(c.skill);
    });
  },

  // A skill the server keeps rejecting (range, weapon, mount, ...) is skipped
  // for 5/10/20/40 s so the loop moves on to the next entry or normal attack.
  blocked(id) {
    const s = this.stuck.get(id);
    return !!s && now() < s.until;
  },

  fail(id) {
    const s = this.stuck.get(id) || { n: 0, until: 0 };
    s.n = Math.min(s.n + 1, 4);
    s.until = now() + 5000 * 2 ** (s.n - 1);
    this.stuck.set(id, s);
    Log.warn('Skill refused, skipping for ' + (s.until - now()) / 1000 + ' s: ' + World.skillName(id));
  },

  resolve(entry) {
    if (!entry) return 0;
    if (entry.iceField || isFrostNovaIceField(entry.id)) {
      const rows = World.groups.get(entry.group) || [];
      let best = 0, level = -Infinity;
      for (const row of rows) {
        if (isFrostNovaIceField(row.id) && World.learned(row.id) && (row.level ?? 0) > level) {
          best = row.id;
          level = row.level ?? 0;
        }
      }
      return best || (World.learned(entry.id) ? entry.id : 0);
    }
    return World.bestOfGroup(entry.group, entry.id);
  },

  meta(id) {
    return World.skill(id) || null;
  },

  mpOk(id, me) {
    const m = this.meta(id);
    return !m || (m.mp ?? 0) + Math.trunc(me.maxMp * (m.mpPercent ?? 0) / 100) <= me.mp;
  },

  busy() {
    const gap = Settings.profile.macro.castGapMs ?? 250;
    return World.isCasting() || now() - this.lastCastAt < gap || World.gp?.targetPending;
  },

  cast(id, gid, label) {
    // Silent rejection: the last send of this skill started neither a cooldown
    // nor a cast (canCast passed again), so count it as a miss.
    if (id === this.lastCastId && now() - this.lastCastAt < 1500 && now() - this.lastCastAt > 700 && World.gp !== this.lastCastState && World.cooldownLeft(id) <= 0 && !World.isCasting()) {
      const s = this.stuck.get(id) || { n: 0, until: 0, miss: 0 };
      s.miss = (s.miss || 0) + 1;
      if (s.miss >= 2) {
        s.miss = 0;
        this.stuck.set(id, s);
        this.fail(id);
        return false;
      }
      this.stuck.set(id, s);
    }
    if (!Cmd.skill(id, gid)) return false;
    this.lastCastId = id;
    this.lastCastAt = now();
    this.lastCastState = World.gp;
    Stats.count('casts');
    return true;
  },

  // Keeps configured self buffs up. Returns true when it used the tick.
  buffs(hunting) {
    const M = Settings.profile.macro;
    if (!M.buffs.length || this.busy() || World.isDead()) return false;
    const me = World.me();
    for (const b of M.buffs) {
      if (!b.enabled || (b.mode === 'hunt' && !hunting)) continue;
      const id = this.resolve(b);
      if (!id || this.blocked(id) || !Cmd.canCast(id) || !this.mpOk(id, me)) continue;
      const info = World.skill(id);
      if (info && info.targetRequired) continue;
      const rem = World.buffRemaining(id);
      if (rem >= 0) this.buffSeen.add(b.group);
      const refresh = (b.refreshS ?? 3) * 1000;
      if (rem >= 0 && rem > refresh) continue;
      // Long fallback gap only for effects the buff list never exposed.
      const meta = this.meta(id);
      const minGap = rem < 0 && !this.buffSeen.has(b.group) ? Math.max(4000, Math.min((meta?.durationMs || 20000) * 0.85, 600000)) : 1500;
      if (now() - (this.buffCastAt.get(b.group) || 0) < minGap) continue;
      if (this.cast(id, 0)) {
        this.buffCastAt.set(b.group, now());
        return true;
      }
    }
    return false;
  },

  imbue() {
    const M = Settings.profile.macro;
    if (!M.imbue) return false;
    const id = this.resolve(M.imbue);
    if (!id || this.blocked(id) || !Cmd.canCast(id) || !this.mpOk(id, World.me())) return false;
    const rem = World.buffRemaining(id);
    if (rem > 400) return false;
    if (rem < 0 && now() - (this.buffCastAt.get('imbue') || 0) < 1200) return false;
    if (this.cast(id, 0)) {
      this.buffCastAt.set('imbue', now());
      return true;
    }
    return false;
  },

  berserk(cls) {
    const mode = Settings.profile.macro.berserk;
    if (mode === 'off' || World.berserkGauge < 5) return false;
    if (World.local()?.appearanceState?.[2] === 1) return false;
    if (mode === 'strong' && !['giant', 'party', 'unique', 'titan', 'elite', 'champion'].includes(cls)) return false;
    return Cmd.berserk();
  },

  rotation(cls) {
    const M = Settings.profile.macro;
    const list = M.rotations[rotationKey(cls)] || [];
    if (!list.length && M.fallbackToNormal) return M.rotations.normal || [];
    return list;
  },

  // Why the last normal attack replaced a skill (counts only: no names), for the panel and diagnostics.
  fallback: null,
  noteFallback(skipped, size) {
    this.fallback = { at: now(), skipped: { ...skipped }, size };
    if (now() - (this.fallbackLogAt || 0) > 30000) {
      this.fallbackLogAt = now();
      Log.warn('Normal attack used instead of skills: ' + this.fallbackNote(true));
    }
  },
  fallbackNote(any = false) {
    const f = this.fallback;
    if (!f || !any && now() - f.at > 8000) return '';
    const names = { unlearned: 'not learned', blocked: 'paused after a server rejection', cooldown: 'cooling down', mp: 'not enough MP', refused: 'not sent', lowMp: 'MP below the minimum' };
    const parts = Object.entries(f.skipped).map(([k, n]) => (k === 'lowMp' ? '' : n + ' ') + names[k]);
    return f.size ? parts.join(', ') || 'no usable rotation skill' : 'no skills in the rotation for this monster class';
  },

  // One step of fighting the given monster.
  fight(target) {
    if (!target || this.busy()) return;
    if (World.gp.target !== target.gid) return;
    const M = Settings.profile.macro;
    const me = World.me();
    const cls = monsterClass(target);
    if (this.berserk(cls)) return;
    const lowMp = M.minMpPct && me.mpPct < M.minMpPct;
    const skipped = {};
    if (!lowMp) {
      for (const entry of this.rotation(cls)) {
        const id = this.resolve(entry);
        const why = !id ? 'unlearned' : this.blocked(id) ? 'blocked' : !Cmd.canCast(id) ? 'cooldown' : !this.mpOk(id, me) ? 'mp' : '';
        if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
        if (M.imbueBeforeAttack && this.imbue()) return;
        if (this.cast(id, target.gid)) return;
        skipped.refused = (skipped.refused || 0) + 1;
      }
    } else skipped.lowMp = 1;
    if (!M.normalAttack) return;
    const sim = World.simNow() ?? 0;
    const lastHit = World.hitByUs.get(target.gid) ?? -Infinity;
    if (sim - lastHit > 2200 && now() - this.lastAttackAt > 1600) {
      if (Cmd.attack(target.gid)) {
        this.lastAttackAt = now();
        this.noteFallback(skipped, this.rotation(cls).length);
      }
    }
  },
};

// Automatic potion shopping. The recorded walking route is replayed in both directions.
const Restock = {
  recording: false,
  draft: null,
  trip: null,
  message: '',
  cfg() { return Settings.profile.potion.restock; },
  pose() {
    const p = World.pose();
    return p && { regionId: p.regionId, x: p.x, y: p.y, z: p.z };
  },
  count(ref) { return World.items().filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  offerKind(o) {
    const rows = o.items || o.previews || [];
    const item = rows.find(i => i.refObjId === o.refObjId);
    const cat = ItemType.potionCategory(item?.typeFlags ?? 0);
    // Only single-item gold offers; package quantities have different purchase semantics.
    if (o.currency !== undefined && o.currency !== 1) return '';
    if (o.contents?.length && (o.contents.length !== 1 || o.contents[0].refObjId !== o.refObjId || o.contents[0].quantity !== 1)) return '';
    return cat === 1 ? 'hp' : cat === 2 ? 'mp' : cat === 3 ? 'vigor' : o.refObjId === 58 && ItemType.isCure(item?.typeFlags ?? 0) ? 'cure' : '';
  },
  activeShop() {
    const gp = World.gp;
    return gp?.shop && gp.target === gp.shop.npc && !gp.targetPending ? gp.shop : null;
  },
  tell(text) { this.message = text; UI.toast(text, 'info', 5000); },
  beginRecording() {
    if (Alchemy.run || Alchemy.pending) return UI.toast('Stop alchemy before recording a route.', 'warn');
    const shop = this.activeShop();
    const npc = World.ents.get(shop?.npc);
    const p = this.pose();
    if (Hunt.running || this.trip) return this.tell('Stop hunting first.');
    if (!World.inWorld() || !npc || npc.kind !== 'npc' || !p || !shop.offers.some(o => this.offerKind(o))) {
      return this.tell('Open a potion merchant shop first.');
    }
    this.draft = { vendor: { refObjId: npc.refObjId, name: npc.name, ...p }, route: [p], offers: shop.offers.filter(o => this.offerKind(o)).map(o => ({ refObjId: o.refObjId, name: o.name, kind: this.offerKind(o) })) };
    this.recording = true;
    this.tell('Close the shop, walk to your hunting spot, then click Finish route. Do not teleport.');
  },
  sample(force = false) {
    if (!this.recording) return;
    if (!World.inWorld() || World.isDead()) return this.cancelRecording();
    const p = this.pose(), route = this.draft.route;
    if (!p) return;
    const d = dist2D(route[route.length - 1], p);
    if (!Number.isFinite(d) || d > 300 || route.length >= 10000) {
      this.cancelRecording();
      return this.tell('Route interrupted; record again by walking without teleporting.');
    }
    if (d >= 40 || force && d > 0) route.push(p);
  },
  cancelRecording() { this.recording = false; this.draft = null; },
  finishRecording() {
    this.sample(true);
    if (!this.recording) return;
    const d = this.draft;
    if (d.route.length < 2 || dist2D(d.route[0], d.route[d.route.length - 1]) < 100) return this.tell('Walk to your hunting spot first.');
    const c = this.cfg();
    c.vendor = d.vendor; c.route = d.route; c.offers = d.offers;
    for (const kind of ['hp', 'mp']) {
      if (!d.offers.some(o => o.kind === kind && o.refObjId === c[kind].refObjId)) c[kind].refObjId = d.offers.find(o => o.kind === kind)?.refObjId || 0;
    }
    Hunt.setCenter();
    this.cancelRecording();
    Settings.saveProfile();
    this.tell('Route and hunt centre saved. Choose potions and quantities, then enable auto buying.');
  },
  // Fixed retail Special Universal Pill (small): strongest universal cure, ref 58.
  supplies() { return ['hp', 'mp', 'vigor', 'cure'].filter(k => this.cfg()[k].on).map(k => ({ kind: k, ...this.cfg()[k], ...(k === 'cure' ? { refObjId: 58 } : {}) })); },
  validate() {
    const c = this.cfg(), s = this.supplies();
    if (!c.vendor || c.route.length < 2) return 'Record a merchant-to-hunt route first.';
    if (!s.length || s.some(i => !i.refObjId || !Number.isInteger(i.low) || !Number.isInteger(i.target) || i.low < 0 || i.target <= i.low || i.target > 10000)) return 'Choose potions and set refill quantities above the low-stock thresholds (maximum 10000).';
    return '';
  },
  fail(reason) {
    this.trip = null;
    this.message = reason;
    Log.warn('Auto buy: ' + reason);
    Hunt.stop('Potion restock: ' + reason);
  },
  begin() {
    const error = this.validate();
    if (error) return this.fail(error);
    const c = this.cfg(), p = this.pose();
    let index = -1, distance = Infinity;
    c.route.forEach((r, i) => { const d = dist2D(p, r); if (d < distance) { distance = d; index = i; } });
    if (index < 0 || distance > 500) return this.fail('Too far from the recorded route. Record a route for this hunting area.');
    const route = c.route.slice(0, index + 1).map(r => ({ ...r }));
    route.push(p);
    this.trip = { phase: 'vendor', route, index: route.length - 2, at: now(), movedAt: 0, best: Infinity, progressAt: now(), manualAt: Manual.lastAt, vendor: { ...c.vendor }, supplies: this.supplies(), pending: null };
    Hunt.targetGid = 0; Hunt.lootGid = 0;
    this.message = 'Walking to potion merchant';
    Log.info(this.message);
  },
  walk() {
    const t = this.trip, dest = t.route[t.index];
    if (!dest) return true;
    const distance = dist2D(World.pose(), dest);
    if (!Number.isFinite(distance)) return this.fail('Route is in another region or dungeon.');
    if (distance <= 12) {
      t.index += t.phase === 'vendor' ? -1 : 1;
      t.best = Infinity; t.progressAt = now();
      return !t.route[t.index];
    }
    if (!t.lastPose || dist2D(t.lastPose, World.pose()) > 3) { t.lastPose = { ...World.pose() }; t.progressAt = now(); }
    if (now() - t.progressAt > 20000) return this.fail('Movement blocked for 20 seconds. Check the recorded path.');
    const move = Navigation.next(t, dest, true);
    if (move.error && !move.waiting) return this.fail(move.error);
    if (move.waiting) return false;
    if (World.isSitting()) {
      if (now() - t.movedAt > 2500 && Cmd.action(1000)) t.movedAt = now();
    } else if (now() - t.movedAt > 900 && Cmd.move(move.point)) t.movedAt = now();
    return false;
  },
  tick() {
    if (this.recording) { Hunt.state = 'manual'; return true; }
    const c = this.cfg();
    if (!this.trip) {
      if (!c.enabled || !World.inWorld() || World.isDead() || this.activeShop() || World.gp?.storage || World.gp?.inventoryPending || now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return false;
      if (!this.supplies().some(i => this.count(i.refObjId) <= i.low)) return false;
      this.begin();
      if (!this.trip) return true;
    }
    const t = this.trip, gp = World.gp;
    Hunt.state = 'restock';
    if (!c.enabled) { this.fail('Auto buying disabled during the trip.'); return true; }
    if (World.isDead()) { this.fail('Character died during restocking.'); return true; }
    if (!World.inWorld()) return true;
    if (Manual.lastAt !== t.manualAt) { this.fail('Manual control interrupted restocking. Start hunting again when ready.'); return true; }
    if (t.phase === 'vendor' || t.phase === 'return') {
      const done = this.walk();
      if (!this.trip || !done) return true;
      if (t.phase === 'return') {
        this.trip = null; Hunt.targetGid = 0; Hunt.lootGid = 0;
        Hunt.state = 'search'; this.message = 'Restocked; hunting resumed.';
        Log.info(this.message); return true;
      }
      t.phase = 'open'; t.at = now(); t.openSent = false;
    }
    if (t.phase === 'open') {
      if (now() - t.at > 15000) { this.fail('Merchant did not open the shop.'); return true; }
      const npc = [...World.ents.values()].filter(e => e.kind === 'npc' && e.refObjId === t.vendor.refObjId && dist2D(e, t.vendor) < 200).sort((a, b) => dist2D(World.pose(), a) - dist2D(World.pose(), b))[0];
      if (!npc) return true;
      if (gp.targetPending) return true;
      if (gp.target !== npc.gid) { Cmd.select(npc.gid); return true; }
      if (!t.openSent && !gp.inventoryPending && Cmd.raw({ kind: 'shop-open', gid: npc.gid }, 'Auto buy: open merchant')) { t.openSent = true; t.revision = gp.shopCompletionRevision; }
      // A cached catalogue must not count as a fresh shop-open acknowledgement.
      if (t.openSent && !gp.inventoryPending && gp.shop?.npc === npc.gid && gp.shopCompletionRevision !== t.revision) { t.phase = 'buy'; t.at = now(); }
      return true;
    }
    if (t.phase === 'buy') {
      const shop = this.activeShop();
      if (!shop || shop.error || gp.error) { this.fail(shop?.error || gp.error || 'Merchant selection changed.'); return true; }
      if (t.pending) {
        if (now() - t.pending.at > 12000) { this.fail('Purchase was not confirmed; no repeat purchase sent.'); return true; }
        if (gp.inventoryPending || now() - t.pending.at < 500) return true;
        if (this.count(t.pending.ref) < t.pending.before + t.pending.quantity) return true;
        t.pending = null;
      }
      if (gp.inventoryPending) return true;
      const s = t.supplies.find(i => this.count(i.refObjId) < i.target);
      if (!s) {
        if (Cmd.raw({ kind: 'npc-close' }, 'Auto buy: close merchant')) {
          t.phase = 'return'; t.index = 1; t.best = Infinity; t.progressAt = now(); t.movedAt = 0;
          this.message = 'Returning to hunting spot';
        }
        return true;
      }
      const offer = shop.offers.find(o => o.refObjId === s.refObjId && this.offerKind(o) === s.kind);
      if (!offer) { this.fail(s.kind === 'cure' ? 'Special Universal Pill (small) is unavailable at this merchant.' : 'Selected potion is unavailable at this merchant.'); return true; }
      const before = this.count(s.refObjId);
      const stackRoom = World.items().filter(i => i.refObjId === s.refObjId).reduce((n, i) => n + Math.max(0, offer.maxStack - (i.quantity ?? 1)), 0);
      const quantity = Math.min(s.target - before, offer.purchaseLimit ?? offer.maxStack, 65535, stackRoom + World.freeBagSlots() * offer.maxStack);
      if (quantity < 1) { this.fail('Inventory full; make room for potions.'); return true; }
      const gold = gp.progression?.gold;
      if (gold === undefined || toBigInt(offer.price) * BigInt(quantity) > toBigInt(gold)) { this.fail('Not enough gold for the potion refill.'); return true; }
      if (Cmd.raw({ kind: 'shop-buy', tab: offer.tab, slot: offer.slot, quantity }, `Auto buy: ${offer.name} x${quantity}`)) t.pending = { ref: s.refObjId, before, quantity, at: now() };
      return true;
    }
    return true;
  },
};

const Hunt = {
  running: false,
  paused: false,
  state: 'idle',
  targetGid: 0,
  targetSince: 0,
  targetHpMark: null,
  selTries: 0,
  lootGid: 0,
  lootSince: 0,
  lootBan: new Map(),
  ban: new Map(),
  sitToggleAt: 0,
  lastMoveAt: 0,
  deathAt: 0,
  revived: false,
  pauseUntil: 0,
  pauseReason: '',
  playerSeen: new Map(),

  cfg() {
    return Settings.profile.hunt;
  },

  start() {
    WalkBack.cancel();
    if (!World.inWorld()) return UI.toast('Enter the game world first.', 'warn');
    const H = this.cfg();
    if (!H.center) this.setCenter();
    this.running = true;
    this.paused = false;
    Loot.reset();
    this.state = 'start';
    this.targetGid = 0;
    this.selTries = 0;
    this.lootGid = 0;
    this.revived = false;
    this.ban.clear();
    this.lootBan.clear();
    Stats.huntStart();

    UI.toast('Hunting started', 'info', 2500);
    Sound.play('good');
    Log.info('Hunting started.');
    bus.emit('hunt', true);
  },

  stop(reason) {
    if (!this.running) return;
    if (World.inWorld() && !World.isDead()) Cmd.move(World.pose());
    Restock.trip = null;
    Loot.suspend();
    this.running = false;
    this.state = 'idle';
    Stats.huntStop();
    UI.toast(reason ? 'Hunting stopped: ' + reason : 'Hunting stopped', reason ? 'warn' : 'info', 3500);
    Log.info('Hunting stopped' + (reason ? ': ' + reason : '.'));
    bus.emit('hunt', false);
  },

  toggle() {
    if (WalkBack.active) return WalkBack.cancel();
    this.running ? this.stop() : this.start();
  },

  setCenter() {
    const p = World.pose();
    if (!p) return false;
    Settings.profile.hunt.center = { regionId: p.regionId, x: p.x, y: p.y, z: p.z };
    Settings.saveProfile();
    bus.emit('center');
    return true;
  },

  knownSkillIds() {
    return (World.gp?.skills || []).slice();
  },

  banned(map, gid) {
    const until = map.get(gid);
    if (!until) return false;
    if (until < now()) {
      map.delete(gid);
      return false;
    }
    return true;
  },

  inArea(e) {
    const H = this.cfg();
    if (!H.center) return true;
    return dist2D(H.center, e) <= H.radius;
  },

  underAttack(ms = 5000) {
    const sim = World.simNow();
    if (sim == null) return false;
    for (const [gid, at] of World.attackers) {
      if (sim - at > ms) continue;
      const e = World.ents.get(gid);
      if (e && World.isAlive(e)) return true;
    }
    return false;
  },

  classAllowed(e) {
    const cls = monsterClass(e);
    return !!this.cfg().classes[cls];
  },

  chooseTarget() {
    const H = this.cfg();
    const pose = World.pose();
    if (!pose) return null;
    const sim = World.simNow() ?? 0;
    const inc = splitList(H.include);
    const exc = splitList(H.exclude);
    let best = null;
    let bestScore = Infinity;
    for (const e of World.ents.values()) {
      if (!isAttackableMob(e) || this.banned(this.ban, e.gid)) continue;
      const attacking = sim - (World.attackers.get(e.gid) ?? -Infinity) < 6000;
      const d = dist2D(pose, e);
      if (!attacking) {
        if (!this.classAllowed(e)) continue;
        if (H.levelMin && (e.level ?? 0) < H.levelMin) continue;
        if (H.levelMax && (e.level ?? 0) > H.levelMax) continue;
        const name = (e.name || '').toLowerCase();
        if (inc.length && !inc.some((s) => name.includes(s))) continue;
        if (exc.some((s) => name.includes(s))) continue;
        if (!this.inArea(e) || d > H.chase) continue;
        if (H.avoidKs && sim - (World.hitByOthers.get(e.gid) ?? -Infinity) < 8000 && sim - (World.hitByUs.get(e.gid) ?? -Infinity) > 8000) continue;
      } else if (d > H.chase * 1.5) continue;
      let score = d;
      if (H.priority === 'attackers' && attacking) score -= 100000;
      if (H.priority === 'lowhp') score = (World.hpPctOf(e) ?? 100) * 20 + d / 10 - (attacking ? 50000 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  },

  playerCheck() {
    const A = this.cfg().playerAlert;
    if (!A.enabled) return false;
    const pose = World.pose();
    const party = new Set((World.gp?.social?.members || []).map((m) => m.name));
    let found = null;
    for (const e of World.ents.values()) {
      if (e.kind !== 'player' || party.has(e.name)) continue;
      if (dist2D(pose, e) > A.radius) continue;
      found = e;
      const last = this.playerSeen.get(e.gid) || 0;
      if (now() - last > 60000) {
        this.playerSeen.set(e.gid, now());
        bus.emit('alert', 'player', e);
      }
    }
    return !!(found && A.pause);
  },

  currentTarget() {
    if (!this.targetGid) return null;
    const e = World.ents.get(this.targetGid);
    if (!e || !isAttackableMob(e)) {
      this.targetGid = 0;
      return null;
    }
    // Give up on targets we cannot damage (blocked path, invulnerable, ...).
    const H = this.cfg();
    const hp = World.hpOf(e.gid);
    if (hp !== this.targetHpMark) {
      this.targetHpMark = hp;
      this.targetSince = now();
    } else if (now() - this.targetSince > H.targetTimeoutS * 1000) {
      this.ban.set(e.gid, now() + 60000);
      Log.warn('Target dropped (no damage dealt): ' + (e.name || e.gid));
      this.targetGid = 0;
      return null;
    }
    return e;
  },

  engage(target) {
    if (this.targetGid !== target.gid) {
      this.targetGid = target.gid;
      this.targetSince = now();
      this.targetHpMark = World.hpOf(target.gid);
      this.selTries = 0;
    }
    if (World.gp.target !== target.gid) {
      this.state = 'select';
      if (World.gp.targetPending) return; // wait for the grant/rejection of the last send
      if (this.selTries >= 3) {
        // 3 unconfirmed selects: the server refuses this gid.
        this.ban.set(target.gid, now() + 60000);
        Log.warn('Target could not be selected, dropped: ' + (target.name || target.gid));
        this.targetGid = 0;
        this.selTries = 0;
        return;
      }
      if (Cmd.select(target.gid)) this.selTries++;
      return;
    }
    this.selTries = 0;
    this.state = 'fight';
    Combat.fight(target);
  },

  stateText() {
    const S = {
      restock: 'Restocking / returning to hunt',
      idle: 'Idle',
      start: 'Starting',
      waiting: 'Waiting for game',
      dead: 'Dead',
      manual: 'Manual control',
      player: 'Player nearby (paused)',
      resting: 'Resting',
      standing: 'Standing up',
      buff: 'Buffing',
      loot: 'Looting',
      search: 'Searching',
      return: 'Returning',
      select: 'Selecting',
      fight: 'Fighting',
    };
    return S[this.state] || this.state;
  },
};

// Outdoor routing over the collision product already admitted by the game.
// A 20-unit A* grid respects blocked terrain, object walls and linked portals.
// Native movement remains the final authority for height and collision response.
const Navigation = {
  scene: null, revision: 0, error: '',
  bytes(value, size) {
    const raw = atob(value), out = Uint8Array.from(raw, c => c.charCodeAt(0));
    if (out.length !== size) throw Error('Invalid navigation grid');
    return out;
  },
  capture(command) {
    const c = command?.command || command;
    if (c?.kind !== 'navigation') return;
    try { this.install(c.bundle); } catch (e) { this.scene = null; this.error = e.message; Log.warn('Walk-back navigation: ' + e.message); }
  },
  install(product) {
    if (!product?.complete || (product.regionId & DUNGEON)) throw Error('Outdoor collision data required');
    const nav = product.navmesh;
    if (nav?.tileSize !== 20 || nav.regionSize !== SECTOR || nav.tilesPerAxis !== 96) throw Error('Unsupported collision data');
    const scene = { regionId: product.regionId, grids: new Map(), walls: new Map() };
    for (const row of nav.regions || []) {
      if (Math.abs(row.dx) > 1 || Math.abs(row.dz) > 1) throw Error('Invalid collision coverage');
      scene.grids.set(row.dx + ',' + row.dz, { blocked: this.bytes(row.blockedTiles, 9216),
        cells: new DataView(this.bytes(row.tileCellIds, 36864).buffer), count: row.cells.count });
    }
    const add = wall => {
      const minX = Math.floor((Math.min(wall[0], wall[2]) - 2) / 80), maxX = Math.floor((Math.max(wall[0], wall[2]) + 2) / 80);
      const minZ = Math.floor((Math.min(wall[1], wall[3]) - 2) / 80), maxZ = Math.floor((Math.max(wall[1], wall[3]) + 2) / 80);
      if ((maxX - minX + 1) * (maxZ - minZ + 1) > 10000) throw Error('Oversized collision wall');
      for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
        const key = x + ',' + z;
        if (!scene.walls.has(key)) scene.walls.set(key, []);
        scene.walls.get(key).push(wall);
      }
    };
    for (const p of product.objects || []) {
      const m = p.mesh;
      if (!m || m.passThrough) continue;
      if (p.terrainCells && !p.terrainCells.length) continue;
      const linked = new Set((p.links || []).map(l => l.edge));
      const vertex = id => {
        const x = m.vertices[id * 3], z = m.vertices[id * 3 + 2], c = Math.cos(p.yaw), s = Math.sin(p.yaw);
        return [c * x - s * z + p.x, s * x + c * z + p.z];
      };
      for (let i = 0; i < m.edges.length; i += 6) {
        const outline = m.edges[i + 5] === 0, flags = m.edges[i + 4];
        // Native terrain contact ignores open outlines, terrain-owned surface
        // borders (0x10) and internal edges of terrain-indexed placements.
        if (outline && flags === 0) continue;
        if (p.terrainCells && (!outline || (flags & 0x10))) continue;
        if (outline && (flags & 8) && linked.has(i / 6)) continue;
        if (!outline && !(flags & 3)) continue;
        const wall = [...vertex(m.edges[i]), ...vertex(m.edges[i + 1])];
        // Flags 1/2 block one approach side only. Preserve source-cell winding
        // so an allowed exit from a town object is not turned into an enclosure.
        if (!(flags & 8) && (flags & 3) !== 3 && (flags & 3) && m.cells) {
          const ids = Array.from(m.cells.slice(m.edges[i + 2] * 3, m.edges[i + 2] * 3 + 3));
          if (ids.length === 3) {
            const points = ids.map(vertex);
            wall.push(flags, points.reduce((n, p) => n + p[0], 0) / 3, points.reduce((n, p) => n + p[1], 0) / 3);
          }
        }
        add(wall);
      }
    }
    this.scene = scene; this.error = ''; this.revision++;
  },
  local(p) {
    const d = regionDelta({ regionId: this.scene.regionId, x: 0, z: 0 }, p);
    return d && { x: d[0], z: d[1] };
  },
  pose(p, y) {
    const sx = Math.floor(p.x / SECTOR), sz = Math.floor(p.z / SECTOR);
    return { regionId: ((this.scene.regionId & 255) + sx) | (((this.scene.regionId >>> 8) + sz) << 8),
      x: p.x - sx * SECTOR, z: p.z - sz * SECTOR, y };
  },
  open(x, z) {
    const sx = Math.floor(x / SECTOR), sz = Math.floor(z / SECTOR), grid = this.scene.grids.get(sx + ',' + sz);
    if (!grid) return false;
    const tx = Math.floor((x - sx * SECTOR) / 20), tz = Math.floor((z - sz * SECTOR) / 20), i = tz * 96 + tx;
    return !grid.blocked[i] && grid.cells.getUint32(i * 4, true) < grid.count;
  },
  nearSegment(p, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z, n = dx * dx + dz * dz;
    const t = n ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / n, 0, 1) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
  },
  clear(a, b) {
    const length = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(length / 8));
    for (let i = 1; i <= steps; i++) if (!this.open(a.x + (b.x - a.x) * i / steps, a.z + (b.z - a.z) * i / steps)) return false;
    const minX = Math.floor((Math.min(a.x, b.x) - 2) / 80), maxX = Math.floor((Math.max(a.x, b.x) + 2) / 80);
    const minZ = Math.floor((Math.min(a.z, b.z) - 2) / 80), maxZ = Math.floor((Math.max(a.z, b.z) + 2) / 80);
    const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    const seen = new Set();
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) for (const w of this.scene.walls.get(x + ',' + z) || []) {
      if (seen.has(w)) continue; seen.add(w);
      const c = { x: w[0], z: w[1] }, d = { x: w[2], z: w[3] };
      if (w.length > 4) {
        const side = cross(c, d, { x: w[5], z: w[6] }), approach = cross(c, d, a) || -cross(c, d, b);
        if (Math.abs(side) > 1e-9 && !(approach * side > 0 ? w[4] & 2 : w[4] & 1)) continue;
      }
      const intersects = cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
      if (intersects || Math.min(this.nearSegment(a, c, d), this.nearSegment(b, c, d), this.nearSegment(c, a, b), this.nearSegment(d, a, b)) < 2) return false;
    }
    return true;
  },
  plan(from, to, arrivalRadius = 0) {
    if (!this.scene || (from.regionId | to.regionId) & DUNGEON) return null;
    const start = this.local(from), goal = this.local(to);
    if (!start || !goal || !this.open(start.x, start.z)) return null;
    if (Math.hypot(goal.x - start.x, goal.z - start.z) < 1800 && this.clear(start, goal)) return [to];
    const key = p => p.x + ',' + p.z, center = p => ({ x: p.x * 20 + 10, z: p.z * 20 + 10 });
    const h = p => Math.hypot(center(p).x - goal.x, center(p).z - goal.z) / 20;
    const first = { x: Math.floor(start.x / 20), z: Math.floor(start.z / 20), g: 0, parent: null };
    first.f = h(first); const scores = new Map([[key(first), 0]]), closed = new Set(), heap = [];
    const push = p => { heap.push(p); let i = heap.length - 1; while (i) { const parent = (i - 1) >> 1; if (heap[parent].f <= p.f) break; heap[i] = heap[parent]; i = parent; } heap[i] = p; };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let c = i * 2 + 1; if (c + 1 < heap.length && heap[c + 1].f < heap[c].f) c++; if (last.f <= heap[c].f) break; heap[i] = heap[c]; i = c; } heap[i] = last; }
      return top;
    };
    push(first); let best = first, reached = false;
    for (let n = 0; heap.length && n < 60000; n++) {
      const p = pop(), k = key(p); if (closed.has(k)) continue; closed.add(k);
      if (h(p) < h(best)) best = p;
      const a = p === first ? start : center(p);
      if (Math.hypot(a.x - goal.x, a.z - goal.z) <= arrivalRadius) { best = p; reached = true; break; }
      if (h(p) < 2 && this.clear(a, goal)) { best = p; reached = true; break; }
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
        const q = { x: p.x + dx, z: p.z + dz, g: p.g + Math.hypot(dx, dz), parent: p }, b = center(q), qk = key(q);
        if (closed.has(qk) || q.g >= (scores.get(qk) ?? Infinity) || !this.clear(a, b)) continue;
        if (dx && dz && (!this.open(a.x + dx * 20, a.z) || !this.open(a.x, a.z + dz * 20))) continue;
        q.f = q.g + h(q); scores.set(qk, q.g); push(q);
      }
    }
    const goalCovered = this.scene.grids.has(Math.floor(goal.x / SECTOR) + ',' + Math.floor(goal.z / SECTOR));
    if (!reached && (goalCovered || h(first) - h(best) < 2)) return [];
    const path = []; for (let p = best; p && p !== first; p = p.parent) path.push(center(p)); path.reverse();
    if (reached && (!arrivalRadius || Math.hypot(center(best).x - goal.x, center(best).z - goal.z) > arrivalRadius)) path.push(goal);
    // Smooth only segments whose terrain and object collision checks both pass.
    const result = []; let anchor = start;
    for (let i = 0; i < path.length;) {
      let j = i; while (j + 1 < path.length && Math.hypot(path[j + 1].x - anchor.x, path[j + 1].z - anchor.z) < 600 && this.clear(anchor, path[j + 1])) j++;
      result.push(this.pose(path[j], from.y)); anchor = path[j]; i = j + 1;
    }
    return result;
  },
  next(owner, destination, recorded = false, arrivalRadius = 0) {
    const pose = World.pose(), previous = owner.travel;
    if (!this.scene || (pose.regionId & DUNGEON)) {
      return recorded ? { point: destination } : { waiting: true, error: this.error || 'Waiting for game collision data. Reload the game if attached late, or record a walking route.' };
    }
    if (!previous || previous.revision !== this.revision || dist2D(previous.destination, destination) > 1 || previous.index >= previous.route.length) {
      let route = this.plan(pose, destination);
      if (route && !route.length && arrivalRadius > 0) route = this.plan(pose, destination, arrivalRadius);
      if (!route) return { waiting: true, error: 'Waiting for collision coverage at the current position.' };
      if (!route.length) return { error: 'No walkable route found through the loaded collision map.' };
      owner.travel = { destination: { ...destination }, route, index: 0, revision: this.revision };
    }
    const travel = owner.travel;
    while (travel.index < travel.route.length && dist2D(pose, travel.route[travel.index]) <= 7) travel.index++;
    return travel.index < travel.route.length ? { point: travel.route[travel.index] } : { waiting: true };
  },
};
Hook.observers.push(command => Navigation.capture(command));


// Independent return command using the saved hunt centre and native movement.
const WalkBack = {
  active: null,
  start(resume = false) {
    if (BuffGear.run || BuffGear.recovery) return UI.toast('Restore or review combat gear before travelling.', 'warn');
    if (Alchemy.run || Alchemy.pending) return UI.toast('Stop alchemy and wait for its result before travelling.', 'warn');
    if (Town.trip) return UI.toast('Stop the town cycle before starting walk-back.', 'warn');
    if (!World.inWorld() || World.isDead()) return UI.toast('Enter the world with a living character first.', 'warn');
    const dest = Settings.profile.hunt.center, pose = World.pose();
    if (!dest || !pose) return UI.toast('Save a hunting spot first using Set here in Hunt → Area.', 'warn');
    if (!Number.isFinite(dist2D(pose, dest))) return UI.toast('Return to the same world or dungeon before walking back.', 'warn');
    if (World.gp?.inventoryPending) return UI.toast('Wait for the inventory transaction to finish.', 'warn');
    Resurrect.cancelTrip('', true); Resurrect.holdUntil = 0;
    const shouldResume = resume || Hunt.running || !!this.active?.resume;
    this.cancel();
    Restock.cancelRecording();
    if (Hunt.running) Hunt.stop();
    if (Restock.activeShop() || World.gp?.storage) Cmd.raw({ kind: 'npc-close' }, 'Walk back: close merchant');
    const recorded = Restock.cfg().route;
    let route = [], nearest = -1, best = 500;
    if (recorded.length && dist2D(recorded[recorded.length - 1], dest) <= 500) {
      recorded.forEach((p, i) => { const d = dist2D(pose, p); if (d <= best) { nearest = i; best = d; } });
      if (nearest >= 0) route = recorded.slice(nearest).map(p => ({ ...p }));
    }
    route.push({ ...dest });
    this.active = { route, recorded: route.length > 1, index: 0, resume: shouldResume, manualAt: Manual.lastAt, at: now(), progressAt: now(), lastPose: { ...pose }, best: Infinity, sentAt: -Infinity, replans: 0 };
    UI.toast('Walking back to the hunting spot.', 'info', 2500);
  },
  cancel(reason = '', halt = true) {
    if (!this.active) return;
    this.active = null;
    if (halt && World.inWorld() && !World.isDead()) Cmd.move(World.pose());
    if (reason) UI.toast(reason, 'warn', 4000);
  },
  tick() {
    const a = this.active;
    if (!a) return;
    if (!World.inWorld() || World.isDead()) return this.cancel('Walk back interrupted.', false);
    if (Manual.lastAt !== a.manualAt) return this.cancel('Manual control: walk back cancelled.', false);
    const dest = a.route[a.index], distance = dist2D(World.pose(), dest);
    if (!Number.isFinite(distance)) return this.cancel('Cannot walk to the saved hunting spot.');
    if (distance <= 12) {
      a.index++; a.best = Infinity; a.progressAt = now();
      if (a.index < a.route.length) return;
      this.active = null;
      UI.toast('Back at the hunting spot.', 'info', 2500);
      if (a.resume) Hunt.start();
      return;
    }
    if (dist2D(a.lastPose, World.pose()) > 3) { a.lastPose = { ...World.pose() }; a.progressAt = now(); a.replans = 0; }
    if (now() - a.progressAt > 20000 || now() - a.at > 600000) return this.cancel('Walk back stopped: path blocked or travel timed out.');
    if (now() - a.progressAt > 6000 && a.travel && a.replans < 2) { a.travel = null; a.replans++; a.sentAt = -Infinity; }
    const move = Navigation.next(a, dest, a.recorded);
    if (move.error && !move.waiting) return this.cancel(move.error);
    if (move.waiting) {
      if (move.error && a.navMessage !== move.error) { a.navMessage = move.error; UI.toast(move.error, 'warn'); }
      return;
    }
    if (World.isSitting()) {
      if (now() - a.sentAt >= 2500 && Cmd.action(1000)) a.sentAt = now();
    } else if (now() - a.sentAt >= 900 && Cmd.move(move.point)) a.sentAt = now();
  },
};


// One pickup intent at a time. Progress, inventory changes and failures own its lifetime.
const Loot = {
  active: null,
  skips: new Map(),
  failureCounts: new Map(),
  petSetup: null,
  fullAlert: null,
  lastFullChimeAt: -Infinity,
  checkPetFull() {
    const P = Hunt.cfg().pickup;
    if (!Hunt.running || !World.inWorld() || World.isDead() || !P.enabled || !this.petMode() || !P.petFullSound) return;
    const pet = this.pet();
    if (!pet || pet.rec.inventory.length < pet.rec.status) { this.fullAlert = null; return; }
    let alert = this.fullAlert;
    if (!alert || alert.gid !== pet.rec.gid) {
      alert = this.fullAlert = { gid: pet.rec.gid, sounded: false };
      UI.toast('Pickup pet bag is full. ' + (Town.cfg().enabled ? 'Town service will take priority over hunting.' : 'Scroll town cycle is off; enable it in Supplies for automatic return.'), 'warn', 6000);
    }
    if (!alert.sounded && now() - this.lastFullChimeAt >= 30000) {
      this.lastFullChimeAt = now();
      alert.sounded = Sound.play('pet-full');
    }
  },
  pet() {
    for (const rec of World.gp?.cosRecords || []) {
      const ent = World.ents.get(rec.gid);
      if (rec.band === 4 && !rec.dead && rec.hp > 0 && rec.status > 0 && Array.isArray(rec.inventory) &&
          ent?.kind === 'cos' && ent.ownerGid === World.localGid() && ent.refObjId === rec.refObjId) return { rec, ent };
    }
    return null;
  },
  petMode() { return Hunt.cfg().pickup.collector === 'pet'; },
  preparePet() {
    if (!this.petMode() || !Hunt.cfg().pickup.enabled || World.isDead()) return false;
    const pet = this.pet();
    if (!pet || !Number.isInteger(pet.rec.commandMode)) return false;
    if (!(pet.rec.commandMode & 128)) { this.petSetup = null; return true; }
    // Native auto-grab has only gold/equipment/other categories. Disable it and
    // wait for the live server-confirmed mode before submitting selective requests.
    let setup = this.petSetup;
    if (!setup || setup.gid !== pet.rec.gid) setup = this.petSetup = { gid: pet.rec.gid, attempts: 0, at: -Infinity };
    if (setup.attempts < 3 && now() - setup.at >= 5000 && !World.gp.inventoryPending && Cmd.spaced('cos-behavior') &&
        Cmd.raw({ kind: 'cos-behavior', gid: pet.rec.gid, mode: (pet.rec.commandMode & ~128) >>> 0 }, 'Disable broad pet auto-grab')) {
      setup.attempts++; setup.at = now();
    }
    return false;
  },
  petStatus() {
    const pet = this.pet();
    if (!pet) return 'Summon a pickup pet to collect into its bag.';
    if (!Number.isInteger(pet.rec.commandMode)) return 'Waiting for pet settings.';
    if (pet.rec.commandMode & 128) return this.petSetup?.attempts >= 3 && now() - this.petSetup.at >= 5000
      ? 'Auto-grab was not disabled. Turn it off in the game pet settings, then retry.' : 'Waiting for broad auto-grab to turn off.';
    if (Hunt.running && World.gp.inventoryPending) return 'Pet waiting for pickup / inventory transaction to finish.';
    if (Hunt.running && this.pressed()) return 'Pet waiting briefly for potion use.';
    if (this.active?.petGid === pet.rec.gid) return 'Pet collecting: ' + (this.active.name || this.active.gid) + (this.active.retryAt ? ' (retry pending).' : '.');
    return `Pet ready: ${Math.max(0, pet.rec.status - pet.rec.inventory.length)} empty slots. Collects while hunting; auto-grab stays off when stopped.`;
  },
  items(petGid = 0) { return petGid ? World.gp?.cosRecords?.find(r => r.gid === petGid)?.inventory || [] : World.items(); },
  pickup(gid, petGid = 0) {
    return petGid ? Cmd.spaced('cos-pickup') && Cmd.raw({ kind: 'cos-pickup', gid: petGid, target: gid }, 'Pet pickup') : Cmd.pickup(gid);
  },
  pressed() {
    // Controller runs potions first. Reserve only a short window after an
    // actual send, including the gap before inventoryPending reaches our mirror.
    // A threshold margin can otherwise block the pet indefinitely.
    return Potion.lastUse > 0 && now() - Potion.lastUse < 350;
  },
  categories: ['gold', 'potions', 'equipment', 'elixirs', 'powders', 'magicStones', 'attrStones', 'alchemy', 'others'],
  category(tf) {
    if (ItemType.isGold(tf)) return 'gold';
    if (ItemType.isPotion(tf) || ItemType.isCure(tf)) return 'potions';
    if (ItemType.isEquipment(tf)) return 'equipment';
    // Native alchemy item words: (TID1,TID2,TID3,TID4), also used by reinforce.go.
    const consumable = (tf & 126) === 108, t3 = (tf >>> 7) & 15, t4 = (tf >>> 11) & 31;
    if (consumable && t3 === 10 && t4 === 1) return 'elixirs';
    if (consumable && t3 === 10 && t4 === 2) return 'powders';
    // Magic stones also cover the Astral, Luck, Steady and Immortal stones; tablets stay under other alchemy items.
    if (consumable && t3 === 11 && (t4 === 1 || t4 === 7)) return 'magicStones';
    if (consumable && t3 === 11 && t4 === 2) return 'attrStones';
    if (consumable && (t3 === 10 || t3 === 11)) return 'alchemy';
    return 'others';
  },
  preset(mode) {
    const p = Hunt.cfg().pickup;
    for (const key of this.categories) p[key] = mode === 'all' || key === 'elixirs' || (mode === 'elixirs-gold' && key === 'gold');
    p.enabled = true; p.include = '';
    Settings.saveProfile();
  },
  count(ref, petGid = 0) { return this.items(petGid).filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  bagSignature() { const pet = this.petMode() && this.pet(); return `${pet ? pet.rec.gid : 0}:` + this.items(pet ? pet.rec.gid : 0).map(i => `${i.slot}:${i.refObjId}:${i.quantity ?? 1}`).join('|'); },
  owned(e) {
    const gi = e.groundItem;
    if (!gi) return false;
    const local = World.localGid();
    if (gi.claimantGid !== undefined && gi.claimantGid !== local) return false;
    const party = World.gp?.social?.members || [];
    return gi.ownerJid === undefined || gi.ownerJid === local || party.some(m => m.id === gi.ownerJid);
  },
  soxLoadAt: 0,
  // Unknown until the item catalogue loads, so unconfirmed items are never taken.
  ensureCatalogue() {
    if (Items.data.size || now() < this.soxLoadAt) return;
    this.soxLoadAt = now() + 30000; Items.ready().catch(() => {});
  },
  sox(e) {
    this.ensureCatalogue();
    return Items.data.size ? Items.sox(e.refObjId) : 0;
  },
  allowed(e) {
    if (!e || e.kind !== 'ground-item' || !this.owned(e)) return false;
    const P = Hunt.cfg().pickup, tf = e.groundItem.typeFlags ?? e.tidWord ?? 0;
    const name = (e.name || '').toLowerCase();
    if (splitList(P.exclude).some(s => name.includes(s))) return false;
    const included = splitList(P.include).some(s => name.includes(s));
    const gold = ItemType.isGold(tf);
    // SoX-only narrows equipment to Star/Moon/Sun gear; every other category keeps its own switch.
    if (P.soxOnly && ItemType.isEquipment(tf)) { if (!this.sox(e)) return false; }
    else if (!included && !P[this.category(tf)]) return false;
    const pet = this.petMode() ? this.pet() : null;
    if (this.petMode() && (!pet || !Number.isInteger(pet.rec.commandMode) || (pet.rec.commandMode & 128) || dist2D(pet.ent, e) > 500)) return false;
    if (gold || (pet ? pet.rec.status > pet.rec.inventory.length : World.freeBagSlots() > 0)) return true;
    // Ground drops omit quantity/stack ceiling. Permit an existing stack to merge;
    // a server capacity refusal suppresses this drop until inventory changes.
    if (!ItemType.isStackable(tf)) return false;
    return this.items(pet ? pet.rec.gid : 0).some(i => i.refObjId === e.refObjId &&
      (!i.tooltip?.fields?.maxStack || (i.quantity ?? 1) < i.tooltip.fields.maxStack));
  },
  // The first reason a drop in view is not collected, or '' when it is eligible. Follows choose() and allowed().
  whyNot(e) {
    const H = Hunt.cfg(), P = H.pickup, skip = this.skips.get(e.gid);
    if (skip && (skip.bag !== null ? skip.bag === this.bagSignature() : skip.until > now())) return 'failed';
    if (!(dist2D(World.pose(), e) <= P.radius)) return 'far';
    if (H.center && dist2D(H.center, e) > H.radius + P.radius) return 'area';
    if (!this.owned(e)) return 'owner';
    const tf = e.groundItem.typeFlags ?? e.tidWord ?? 0, name = (e.name || '').toLowerCase();
    const included = splitList(P.include).some(s => name.includes(s));
    const filtered = splitList(P.exclude).some(s => name.includes(s)) ||
      (P.soxOnly && ItemType.isEquipment(tf) ? !this.sox(e) : !included && !P[this.category(tf)]);
    if (filtered) return 'filter';
    if (this.petMode()) {
      const pet = this.pet();
      if (!pet || !Number.isInteger(pet.rec.commandMode) || (pet.rec.commandMode & 128)) return 'pet';
      if (dist2D(pet.ent, e) > 500) return 'petFar';
    }
    return this.allowed(e) ? '' : 'full';
  },
  skip(e, reason, inventoryBound = false) {
    const n = Math.min(6, (this.failureCounts.get(e.gid) || 0) + 1);
    this.failureCounts.set(e.gid, n);
    this.skips.set(e.gid, { until: now() + Math.min(60000, 5000 * 2 ** (n - 1)), bag: inventoryBound ? this.bagSignature() : null });
    Log.warn(`Loot skipped (${e.name || e.gid}): ${reason}`);
    this.active = null;
    Hunt.lootGid = 0;
  },
  choose() {
    const H = Hunt.cfg(), P = H.pickup, pose = World.pose();
    if (!P.enabled || !pose) return null;
    const origin = this.petMode() ? this.pet()?.ent : pose;
    if (!origin) return null;
    let chosen = null, best = Infinity;
    for (const e of World.ents.values()) {
      if (e.kind !== 'ground-item') continue;
      const skip = this.skips.get(e.gid);
      if (skip) {
        if (skip.bag !== null ? skip.bag === this.bagSignature() : skip.until > now()) continue;
        this.skips.delete(e.gid);
      }
      const d = dist2D(pose, e);
      if (!Number.isFinite(d) || d > P.radius || H.center && dist2D(H.center, e) > H.radius + P.radius || !this.allowed(e)) continue;
      const travel = dist2D(origin, e);
      if (travel < best) { chosen = e; best = travel; }
    }
    return chosen;
  },
  begin(e) {
    if (!this.allowed(e) || World.gp?.inventoryPending || !this.petMode() && World.isCasting()) return false;
    const petGid = this.petMode() ? this.pet()?.rec.gid : 0;
    if (this.petMode() && (!petGid || this.pressed()) || !this.pickup(e.gid, petGid)) return false;
    const gold = ItemType.isGold(e.groundItem.typeFlags);
    this.active = { gid: e.gid, ref: e.refObjId, name: e.name, gold, petGid,
      before: gold ? toBigInt(World.gp?.progression?.gold) : this.count(e.refObjId, petGid),
      at: now(), progressAt: now(), best: dist2D(petGid ? this.pet().ent : World.pose(), e), attempts: 1,
      retryAt: 0, goneAt: null, failure: '' };
    Hunt.lootGid = e.gid;
    return true;
  },
  gained(a) {
    return a.gold ? toBigInt(World.gp?.progression?.gold) > a.before : this.count(a.ref, a.petGid) > a.before;
  },
  tick() {
    const a = this.active;
    if (!a) return false;
    if (!!a.petGid !== this.petMode() || a.petGid && this.pet()?.rec.gid !== a.petGid) { this.suspend(); return false; }
    if (!a.petGid) Hunt.state = 'loot';
    const e = World.ents.get(a.gid);
    if (this.gained(a)) {
      Stats.pickup(a);
      // If inventory updates precede despawn, don't request this same drop again.
      this.skips.set(a.gid, { until: now() + 3000, bag: null });
      this.failureCounts.delete(a.gid);
      this.active = null; Hunt.lootGid = 0;
      return true;
    }
    if (!e) {
      a.goneAt ??= now();
      if (now() - a.goneAt < 1500) return true; // allow a delayed inventory/gold update
      Log.info(`Drop disappeared without a matching inventory gain: ${a.name || a.gid}`);
      this.active = null; Hunt.lootGid = 0;
      return false;
    }
    if (!this.allowed(e) || !Hunt.cfg().pickup.enabled) {
      if (!a.petGid && !Cmd.move(World.pose())) return true;
      this.suspend(); return false;
    }
    const d = dist2D(a.petGid ? this.pet().ent : World.pose(), e);
    if (d < a.best - 2) { a.best = d; a.progressAt = now(); }
    if (World.gp?.inventoryPending) return true;
    if (a.retryAt) {
      if (now() < a.retryAt) return true;
      if (a.petGid && this.pressed()) return true;
      if (this.pickup(a.gid, a.petGid)) {
        a.attempts++; a.retryAt = 0; a.at = now(); a.progressAt = now(); a.best = d; a.failure = '';
      }
      return true;
    }
    // Keep the approach alive while moving; don't expire it after a fixed 4.5 seconds.
    if (!a.failure && now() - a.progressAt < 8000 && now() - a.at < 45000) return true;
    const reason = a.failure || 'no approach/pickup progress';
    const capacity = /full|capacity|(?:not enough|no|out of) (?:free |inventory |bag )?space|envanter.*dolu/i.test(reason);
    if (capacity || a.attempts > Hunt.cfg().pickup.retries) { this.skip(e, reason, capacity); return false; }
    // Movement cancels the outstanding worker pickup intent. Resubmit on a later tick.
    if (a.petGid || Cmd.move(World.pose())) { a.retryAt = now() + 700; a.failure = ''; }
    return true;
  },
  suspend() { this.active = null; Hunt.lootGid = 0; },
  reset() { this.suspend(); this.skips.clear(); this.failureCounts.clear(); this.petSetup = null; this.fullAlert = null; },
  init() {
    bus.on('game-error', message => {
      if (!this.active) return;
      const reason = String(message);
      // The shared error field also contains combat and item-use failures.
      // Only native COS-ground/transaction refusals can fail a pet request;
      // generic inventory refusals are transient, never proof its bag is full.
      if (this.active.petGid && !/^(?:Inventory (?:command unavailable|rejected: \d+)|No owned COS ground authority|Invalid COS ground request|Unmatched COS ground result)$/.test(reason)) return;
      this.active.failure = reason;
    });
    bus.on('despawn', e => {
      this.skips.delete(e.gid); this.failureCounts.delete(e.gid);
    });
  },
};


// Page-local hunting session. No persistence, uploads or gameplay commands.
const Stats = {
  values: { loot: 0, casts: 0, potions: 0, deaths: 0 },
  session: { ms: 0, xp: 0n, gold: 0n, kills: 0, deaths: 0, potions: 0, items: 0, sox: 0 },
  active: false, lastAt: null, baseline: null, dead: false, character: null, started: false,
  levels: null, loading: null, retryAt: 0, pendingXP: [], xpPartial: false, xpKnown: false, goldKnown: false,
  killed: new Set(), potions: [], potionTotals: new Map(), fields: {},
  integer(value) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
    if (!['string', 'number', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
    try { return BigInt(value); } catch { return null; }
  },
  init() {
    if (this.started) return;
    this.started = true;
    bus.on('gameplay', () => this.sample());
    bus.on('cast', c => this.cast(c));
    bus.on('spawn', e => this.killed.delete(e.gid));
    bus.on('death', e => { if (e.gid === World.localGid()) this.sample(); });
    bus.on('phase', () => this.sample());
    bus.on('reset', () => { this.sample(); this.baseline = null; this.killed.clear(); this.potions = []; this.potionTotals.clear(); });
    bus.on('character', name => {
      if (this.character !== name) { this.character = name; this.killed.clear(); this.reset(); }
    });
  },
  reset() {
    this.values = { loot: 0, casts: 0, potions: 0, deaths: 0 };
    this.session = { ms: 0, xp: 0n, gold: 0n, kills: 0, deaths: 0, potions: 0, items: 0, sox: 0 };
    this.lastAt = now(); this.active = false; this.baseline = null;
    this.dead = World.isDead(); this.pendingXP = []; this.xpPartial = this.xpKnown = this.goldKnown = false;
    this.potions = []; this.potionTotals.clear();
    this.sample(); this.render();
  },
  huntStart() { this.sample(); this.loadLevels(); if (Hunt.cfg().pickup.soxSound) Loot.ensureCatalogue(); },
  huntStop() { this.sample(); },
  count(kind) {
    if (kind in this.values) this.values[kind]++;
  },
  pickup(a) {
    this.count('loot');
    if (Hunt.running && World.inWorld() && !a.gold) this.session.items += Math.max(0, Loot.count(a.ref, a.petGid) - a.before);
    const tier = a.gold || !Hunt.running || !World.inWorld() ? 0 : Items.sox(a.ref);
    if (tier) this.soxFound(a, tier);
  },
  // A confirmed bot pickup of Star/Moon/Sun gear. Unknown items (catalogue not loaded) are not announced.
  soxFound(a, tier) {
    this.session.sox++;
    const name = a.name || Items.name(a.ref), label = ['Star', 'Moon', 'Sun'][tier - 1];
    if (!Hunt.cfg().pickup.soxSound) return;
    UI.toast('SoX found: ' + name + ' (' + label + ')', 'info', 10000);
    Sound.play('sox');
  },
  potion(item) {
    this.count('potions'); this.sample();
    if (!this.active) return;
    if (!this.potionTotals.has(item.refObjId)) this.potionTotals.set(item.refObjId, this.total(item.refObjId));
    this.potions.push({ ref: item.refObjId, at: now() });
    if (this.potions.length > 32) this.potions.shift();
  },
  total(ref) { return (World.gp?.inventory || []).filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  confirmPotions() {
    if (!Array.isArray(World.gp?.inventory)) return;
    this.potions = this.potions.filter(p => now() - p.at <= 15000);
    for (const [ref, before] of this.potionTotals) {
      const current = this.total(ref);
      let consumed = Math.max(0, before - current);
      this.potions = this.potions.filter(p => {
        if (p.ref !== ref || consumed <= 0) return true;
        consumed--; this.session.potions++; return false;
      });
      if (this.potions.some(p => p.ref === ref)) this.potionTotals.set(ref, current);
      else this.potionTotals.delete(ref);
    }
  },
  cast(c) {
    if (!Hunt.running || !World.inWorld()) return;
    const caster = World.ents.get(c.caster);
    if (c.caster !== World.localGid() && !(caster?.kind === 'cos' && caster.ownerGid === World.localGid())) return;
    const targets = (c.results || []).filter(r => (r.impacts || []).some(i => i.fatal)).map(r => r.target);
    if (!(c.results || []).length && c.fatal) targets.push(c.target);
    for (const gid of targets) {
      if (World.ents.get(gid)?.kind !== 'monster' || this.killed.has(gid)) continue;
      this.killed.add(gid); this.session.kills++;
      if (this.killed.size > 1000) this.killed.delete(this.killed.values().next().value);
    }
  },
  xpDelta(a, b) {
    if (a.level === b.level) return b.xp > a.xp ? b.xp - a.xp : 0n;
    if (b.level < a.level) return 0n;
    if (!this.levels) return null;
    let total = b.xp - a.xp;
    for (let level = a.level; level < b.level; level++) {
      const required = this.integer(this.levels[level]?.expRequired);
      if (required === null || required <= 0n) return null;
      total += required;
    }
    return total > 0n ? total : 0n;
  },
  async loadLevels() {
    if (this.levels || this.loading || now() < this.retryAt || !W.location?.origin) return;
    this.retryAt = now() + 30000;
    this.loading = Icons.request('/assets/data/levelData.json', 'json').then(levels => {
      if (!levels || typeof levels !== 'object') throw Error('Invalid level data');
      this.levels = levels;
      for (const [a, b] of this.pendingXP) {
        const delta = this.xpDelta(a, b);
        if (delta === null) this.xpPartial = true; else this.session.xp += delta;
      }
      this.pendingXP = [];
    }).catch(() => {}).finally(() => { this.loading = null; });
    return this.loading;
  },
  sample() {
    const t = now(), live = Hunt.running && World.inWorld();
    if (this.lastAt !== null && this.active) this.session.ms += Math.max(0, t - this.lastAt);
    this.lastAt = t;
    const p = World.gp?.progression, level = p?.level;
    const current = { gid: World.localGid(), epoch: World.epoch, level, xp: this.integer(p?.experience), gold: this.integer(p?.gold) };
    const previous = this.baseline;
    if (this.active && live && previous && current.gid === previous.gid && current.epoch === previous.epoch) {
      if (previous.gold !== null && current.gold !== null) this.session.gold += current.gold - previous.gold;
      if (Number.isInteger(previous.level) && Number.isInteger(level) && previous.xp !== null && current.xp !== null) {
        const delta = this.xpDelta(previous, current);
        if (delta === null) {
          if (this.pendingXP.length < 50) this.pendingXP.push([previous, current]); else this.xpPartial = true;
        } else this.session.xp += delta;
      } else if (this.xpKnown) this.xpPartial = true;
      this.confirmPotions();
    } else { this.potions = []; this.potionTotals.clear(); }
    const dead = World.isDead();
    if (this.active && live && dead && !this.dead) { this.session.deaths++; this.values.deaths++; }
    this.dead = dead;
    this.active = live; this.baseline = live ? current : null;
    if (live) {
      if (current.xp !== null && Number.isInteger(level)) this.xpKnown = true;
      if (current.gold !== null) this.goldKnown = true;
      this.loadLevels();
    }
  },
  number(n) { return n.toLocaleString('en-US'); },
  display() {
    const s = this.session, seconds = Math.floor(s.ms / 1000);
    const time = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
    const partial = this.xpPartial || this.pendingXP.length ? ' (partial)' : '';
    const rate = s.ms >= 30000 ? this.number(s.xp * 3600000n / BigInt(Math.floor(s.ms))) : '—';
    return { state: this.active ? 'Tracking' : 'Paused', time,
      xp: this.xpKnown ? this.number(s.xp) + partial : '—', rate: this.xpKnown ? rate + partial : '—',
      gold: this.goldKnown ? (s.gold > 0n ? '+' : '') + this.number(s.gold) : '—',
      kills: this.number(s.kills), deaths: this.number(s.deaths), potions: this.number(s.potions), items: this.number(s.items), sox: this.number(s.sox) };
  },
  draw(parent) {
    const box = UI.group('Session stats'); this.fields = {};
    for (const [key, label] of [['state','Session'],['time','Hunting time'],['xp','XP gained'],['rate','XP / hour'],['gold','Net gold'],['kills','Confirmed kills'],['deaths','Deaths'],['potions','Potions used'],['items','Items picked up'],['sox','SoX found']]) {
      const value = el('span'); value.setAttribute('aria-label', label); this.fields[key] = value;
      const row = el('div', null, 'field'); row.append(el('span', label), value); box.append(row);
    }
    box.append(UI.button('Reset session', () => this.reset()),
      el('p', 'Local to this page; pauses while hunting is stopped or disconnected. Reset or reload clears totals. Town trips count while hunting stays enabled. Gold includes purchases and repairs. Kills require your or your pet’s fatal result; item counts use confirmed bot pickups; SoX found counts confirmed pickups of Star, Moon and Sun gear. HP, MP, vigor and cure uses require inventory confirmation. XP/hour appears after 30 seconds; partial means a level transition or missing data is unresolved.', 'muted'));
    parent.append(box); this.render();
  },
  render() {
    if (UI.current !== 'Settings') return;
    const data = this.display();
    for (const [key, value] of Object.entries(data)) if (this.fields[key]) this.fields[key].textContent = value;
  },
};


// Approve only correlated applications to the local player's matching listing.
const Party = {
  answered: '',
  registration: null,
  lastRegisterAt: -Infinity,
  message: 'Auto-recruit off.',
  reset() { this.answered = ''; this.registration = null; this.lastRegisterAt = -Infinity; this.message = 'Waiting for party state.'; },
  // Party sharing options: the party's own once formed, else the listing's, else the saved new-party choice.
  options(matching, social) {
    const c = Settings.profile.party;
    return social.leader ? social.options : matching.own?.type ?? ((c.expShare ? 1 : 0) | (c.itemShare ? 2 : 0));
  },
  recruit(matching, social) {
    const c = Settings.profile.party;
    if (!c.autoRecruit) { this.message = 'Auto-recruit off.'; return; }
    if (matching.own) {
      this.registration = null;
      this.message = social.leader && social.self !== social.leader ? 'Listing present; only the leader can auto-accept.' : social.members.length >= (((social.leader ? social.options : matching.own.type) & 1) ? 8 : 4) ? 'Party full; waiting for a free slot.' : 'Listing active; accepting applicants when space is available.';
      return;
    }
    if (this.registration) {
      if (now() - this.registration.at < 15000) { this.message = 'Waiting for registration confirmation.'; return; }
      // A local send can be refused before registration starts. Retry only
      // after a newer native snapshot explicitly confirms no listing or request.
      if (World.gp === this.registration.state) { this.message = 'Registration unconfirmed; waiting for fresh party state before retrying.'; return; }
      if (matching.own !== null || matching.pending !== null || matching.request || matching.joining) {
        this.message = 'Waiting for party matching before retrying registration.'; return;
      }
      this.registration = null;
    }
    if (matching.own !== null || matching.pending !== null || matching.request || matching.joining) { this.message = 'Waiting for party matching.'; return; }
    if (social.leader && (!social.self || social.self !== social.leader) || !social.leader && social.members.length) {
      this.message = 'Waiting until you are solo or party leader.'; return;
    }
    const type = social.leader ? social.options : (c.expShare ? 1 : 0) | (c.itemShare ? 2 : 0);
    if (!Number.isInteger(type) || type < 0 || type > 7) { this.message = 'Waiting for party options.'; return; }
    if (social.members.length >= ((type & 1) ? 8 : 4)) { this.message = 'Party full; waiting for a free slot.'; return; }
    if (!social.leader && !(World.gp?.progression?.level >= 5)) { this.message = 'Level 5 is required to form a listing.'; return; }
    const title = String(c.title || '').trim();
    if (!title || title.length > 50 || !Number.isInteger(c.min) || !Number.isInteger(c.max) || c.min < 1 || c.max > 90 || c.min > c.max) {
      this.message = 'Set a title (1-50 characters) and a level range within 1-90.'; return;
    }
    // Match the client party-matching purpose matrix for the equipped job suit.
    const flags = World.gp.inventory?.find(i => i.slot === 8)?.typeFlags ?? 0, suit = flags >>> 11;
    const job = (flags & 0x7fe) === 0x3ac && suit >= 1 && suit <= 3 ? suit : 4;
    const validPurpose = Number.isInteger(c.purpose) && (job === 1 || job === 3 ? c.purpose === 2 : job === 2 ? c.purpose === 3 : c.purpose >= 0 && c.purpose < 2);
    if (!validPurpose) { this.message = 'Listing purpose does not match your equipped job suit.'; return; }
    if (now() - this.lastRegisterAt < 30000 || !Cmd.spaced('party-match-register')) { this.message = 'Waiting before restoring the listing.'; return; }
    const registration = { party: 0, type, purpose: c.purpose, min: c.min, max: c.max, title };
    if (Cmd.raw({ kind: 'party-match-register', registration }, 'Auto-recruit: register party listing')) {
      this.registration = { at: now(), state: World.gp }; this.lastRegisterAt = now();
      this.message = 'Waiting for registration confirmation.';
    }
  },
  // Hunting at the moment of death is remembered, so a resurrection accepted within 15 minutes resumes it whatever the
  // "On death" setting did. A revive the player or the bot does itself never resumes anything.
  huntAtDeath: null, resumeHunt: null, consentAt: -Infinity, aliveSince: 0,
  noteDeath() { if (Hunt.running && !this.huntAtDeath) this.huntAtDeath = { at: now() }; },
  // Another online party member who is up and in view might resurrect us.
  helperNearby() {
    const social = World.gp?.social;
    return !!social?.members?.some(m => m && m.name && m.name !== social.localName && (m.status & 15) === 0 &&
      [...World.ents.values()].some(e => e.kind === 'player' && e.name === m.name && e.appearanceState?.[0] !== 2));
  },
  // With Accept resurrection on and a helper at hand, wait longer before the bot revives itself.
  reviveDelay() { return Settings.profile.party.acceptRes && this.helperNearby() ? 20000 : 5000; },
  // Never revive while an offer is open or an acceptance was just sent.
  resBusy() { return !!World.gp?.social?.resurrection || now() - this.consentAt < 4000; },
  resumeTick() {
    const r = this.resumeHunt;
    if (this.huntAtDeath && now() - this.huntAtDeath.at > 15 * 60000) this.huntAtDeath = null;
    if (!World.inWorld() || World.isDead()) { this.aliveSince = 0; return; }
    if (!this.aliveSince) this.aliveSince = now();
    if (!r) {
      // Alive without an accepted resurrection: the memory belongs to a death that is over.
      if (this.huntAtDeath && now() - this.aliveSince > 10000) this.huntAtDeath = null;
      return;
    }
    if (Hunt.running) { this.resumeHunt = this.huntAtDeath = null; return; }
    if (now() - r.at > 120000) { this.resumeHunt = this.huntAtDeath = null; return; }
    if (now() - this.aliveSince < 2000 || !World.local() || World.gp?.inventoryPending) return;
    this.resumeHunt = this.huntAtDeath = null;
    Controller.resumeHunting('Resurrected');
  },
  // A dead character gets a Yes/No resurrection question from a caster's Rebirth skill. Only party members
  // are answered, and only while dead; other questions (including mutation proposals) are left to the player.
  acceptResurrection() {
    const c = Settings.profile.party, social = World.gp?.social, question = social?.resurrection;
    if (!c.acceptRes || !question || question.mutation || !World.inWorld() || !World.isDead() || !Array.isArray(social.members)) return;
    const caster = World.ents.get(question.gid);
    if (!caster?.name || !social.members.some(m => m?.name === caster.name && m.name !== social.localName)) return;
    if (!Cmd.spaced('resurrection-consent')) return;
    if (Cmd.raw({ kind: 'resurrection-consent', accept: true }, 'Accept resurrection from ' + caster.name)) {
      this.consentAt = now();
      this.resumeHunt = this.huntAtDeath && !Hunt.running && now() - this.huntAtDeath.at < 15 * 60000 ? { at: now() } : null;
      UI.toast('Accepted resurrection from ' + caster.name, 'info', 3000);
    }
  },
  tick() {
    this.acceptResurrection();
    const c = Settings.profile.party;
    if (!World.inWorld() || (!c.autoAcceptMatching && !c.autoRecruit)) return;
    const gp = World.gp, matching = gp?.partyMatching, request = matching?.request, social = gp?.social;
    if (!matching || !social || !Array.isArray(social.members)) return;
    this.recruit(matching, social);
    if (!request) { this.answered = ''; return; }
    if (!social || !Array.isArray(social.members)) return;
    // An owned listing can exist before the first applicant forms the party.
    // The game only routes applications to the listing's owner, and the local listing record can be
    // missing while the server's still exists (it is wiped on world entry and after a party dissolves),
    // so a live application is enough; the leader, capacity and deadline checks below still apply.
    if (social.leader && (!social.self || social.self !== social.leader)) return;
    if (!social.leader && social.members.length) return;
    const options = this.options(matching, social);
    if (!Number.isInteger(options) || social.members.length >= ((options & 1) ? 8 : 4)) return;
    const sim = World.simNow();
    if (!Number.isFinite(sim) || !Number.isFinite(request.expires) || sim >= request.expires) return;
    if (![request.a, request.b].every(id => Number.isInteger(id) && id > 0 && id <= 0xffffffff)) return;
    const key = `${request.a}:${request.b}:${request.expires}`;
    if (key === this.answered || !Cmd.spaced('party-match-answer')) return;
    // Same correlation and accept value as the game's matching approval button.
    if (Cmd.raw({ kind: 'party-match-answer', a: request.a, b: request.b, answer: 1 }, 'Auto-accept party-matching application')) {
      this.answered = key;
      UI.toast('Party join acceptance sent: ' + (request.member?.name || 'Applicant'), 'info', 3000);
    }
  },
};
// Hits by party members, and by their pets, do not make a monster "another player's target": hunting together is the
// point of a party, and No-KS would otherwise skip every monster the party is already fighting.
{
  const record = World.onCast;
  World.onCast = function (cast) {
    const social = this.gp?.social, caster = this.ents.get(cast.caster);
    const owner = caster?.kind === 'cos' ? this.ents.get(caster.ownerGid) : caster;
    const name = owner?.name || (caster?.kind === 'cos' ? caster.ownerName : '');
    const member = !!name && Array.isArray(social?.members) && name !== social.localName && social.members.some(m => m?.name === name);
    if (!member) return record.call(this, cast);
    const targets = new Set([cast.target, ...(cast.results || []).map(r => r?.target)].filter(Boolean));
    const before = new Map([...targets].map(gid => [gid, this.hitByOthers.get(gid)]));
    try { return record.call(this, cast); }
    finally { for (const [gid, at] of before) at === undefined ? this.hitByOthers.delete(gid) : this.hitByOthers.set(gid, at); }
  };
}


// Auto-resurrect dead party members with a learned corpse-targeted skill.
// The sim worker replaces a skill press's gid with the newest selection intent
// (core.ts), so the corpse is selected immediately before the press. The server
// proposes the revival, which the dead member answers inside a 30 second window.
// Only in-range corpses are considered when authored range is available.
const Resurrect = {
  sent: {},           // member id -> time of the unanswered proposal
  nextAt: -Infinity,  // earliest next attempt
  holdUntil: 0,
  trip: null,
  windowMs: 31000,    // the server's answer window plus one tick
  message: 'No fallen party member.',
  reset() { this.cancelTrip('', true); this.sent = {}; this.nextAt = -Infinity; this.holdUntil = 0; this.message = 'No fallen party member.'; },
  cancelTrip(message = '', halt = false) {
    if (this.trip && halt && this.trip.phase === 'approach') this.sent[this.trip.member] = now();
    if (this.trip && halt && World.inWorld() && !World.isDead()) Cmd.move(World.pose());
    this.trip = null;
    if (message) { this.message = message; Log.warn(message); }
  },
  returnTrip(message = '') {
    const a = this.trip;
    if (!a) return;
    a.phase = 'return'; a.travel = null; a.at = a.progressAt = now(); a.lastPose = { ...World.pose() }; a.sentAt = -Infinity;
    this.message = message || 'Returning to the hunting spot after resurrection.';
    if (message) Log.info(message);
  },
  travelTick(skill, members) {
    const a = this.trip, pose = World.pose();
    if (!a || !pose) return false;
    const member = members.find(m => m.id === a.member && m.name === a.name);
    const body = World.ents.get(a.gid);
    if (a.phase === 'cast') this.returnTrip();
    if (a.phase === 'approach' && (!member || (member.status & 15) !== 0 || !body || body.name !== a.name || body.appearanceState?.[0] !== 2 ||
        !Number.isFinite(dist2D(a.home, body)) || dist2D(a.home, body) > Settings.profile.party.resRadius)) {
      this.returnTrip('Resurrection target unavailable or outside the configured radius; returning.');
    }
    if (dist2D(a.lastPose, pose) > 3) { a.lastPose = { ...pose }; a.progressAt = now(); }
    if (now() - a.at > 30000 || now() - a.progressAt > 12000) {
      if (a.phase === 'approach') {
        this.sent[a.member] = now() + 30000;
        this.returnTrip('Resurrection travel timed out; returning to the hunting spot.');
      } else {
        this.cancelTrip('Resurrection return blocked or timed out.', true);
        if (Hunt.running) Hunt.stop('Resurrection return blocked or timed out.');
        return false;
      }
    }
    const destination = a.phase === 'return' ? a.home : body;
    const distance = dist2D(pose, destination);
    if (a.phase === 'return' && distance <= 12) { this.trip = null; this.message = 'Back at the hunting spot.'; return false; }
    if (a.phase === 'approach' && distance <= Math.max(1, (skill.range || 150) - 5)) return false;
    if (World.isCasting() || World.isSitting()) return true;
    const move = Navigation.next(a, destination);
    if (move.error && !move.waiting) {
      if (a.phase === 'approach') {
        this.sent[a.member] = now() + 30000;
        this.returnTrip('No walkable route to the party member; returning.');
      } else {
        this.cancelTrip(move.error, true);
        if (Hunt.running) Hunt.stop(move.error);
      }
      return true;
    }
    if (move.waiting) { this.message = move.error || 'Waiting for resurrection travel.'; return true; }
    if (a.phase === 'approach' && dist2D(a.home, move.point) > Math.max(Settings.profile.party.resRadius, dist2D(a.home, pose) + 1)) {
      this.sent[a.member] = now() + 30000; this.returnTrip('Resurrection detour exceeds the configured radius; returning.'); return true;
    }
    if (now() - a.sentAt >= 900 && Cmd.move(move.point)) a.sentAt = now();
    this.message = a.phase === 'return' ? 'Returning to the hunting spot.' : 'Walking into resurrection range: ' + a.name;
    return true;
  },
  // The highest-tier learned corpse-targeted row: the Rebirth family marks
  // itself with the DeadBody target bit, and later tiers carry the higher
  // mastery requirement.
  skill() {
    let best = null;
    for (const id of World.gp?.skills || []) {
      const s = World.skill(id);
      if (!s || !s.targetRequired || !((s.targets ?? 0) & 128)) continue;
      if (!best || this.rank(s) > this.rank(best)) best = s;
    }
    return best;
  },
  rank(s) {
    const mastery = Math.max(0, ...(s.masteries || []).map(m => m.Level || 0));
    return mastery * 1000 + (s.level ?? 0);
  },
  tick() {
    const c = Settings.profile.party;
    if (!c.autoRes) { this.cancelTrip('', true); this.holdUntil = 0; this.message = 'Auto-resurrect off.'; return false; }
    if (!World.inWorld() || World.isDead()) { this.cancelTrip(); this.holdUntil = 0; this.message = 'Waiting for a living character.'; return false; }
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) { this.cancelTrip('Manual control: resurrection travel cancelled.'); this.holdUntil = 0; return false; }
    if (now() < this.holdUntil || this.holdUntil && World.isCasting()) return true;
    this.holdUntil = 0;
    const social = World.gp?.social, members = social?.members;
    if (!Array.isArray(members)) { this.cancelTrip('', true); return false; }
    const party = members.filter(m => m && m.id && m.name && m.name !== social.localName);
    const t = now();
    for (const id of Object.keys(this.sent)) {
      const m = party.find(x => x.id === Number(id));
      if (!m || (m.status & 15) !== 0) delete this.sent[id];
    }
    const offered = party.find(m => this.sent[m.id]);
    this.message = offered ? 'Resurrection offered: ' + offered.name + '; waiting for the answer.' : 'Watching for fallen party members.';
    const skill = this.skill();
    if (!skill) { this.cancelTrip('', true); this.message = 'No learned resurrection skill (Rebirth) was found.'; return; }
    if (this.trip && this.travelTick(skill, party)) return true;
    if (t < this.nextAt || World.gp.targetPending || !Cmd.canCast(skill.id)) return !!this.trip;
    if (World.isCasting() || World.isSitting() || World.local()?.mountedOn || World.gp.inventoryPending ||
        now() - Combat.lastCastAt < Settings.profile.macro.castGapMs || !Combat.mpOk(skill.id, World.me())) return !!this.trip;
    for (const m of party) {
      if ((m.status & 15) !== 0 || this.sent[m.id] && t - this.sent[m.id] < this.windowMs) continue;
      // The corpse must be in view as an entity to aim the select at.
      const e = [...World.ents.values()].find(x => x && x.kind === 'player' && x.name === m.name);
      if (!e || e.appearanceState?.[0] !== 2) continue;
      if (this.trip && e.gid !== this.trip.gid) continue;
      const distance = dist2D(World.pose(), e);
      const home = this.trip?.home || (Hunt.running && Settings.profile.hunt.center) || World.pose();
      if (!Number.isFinite(distance) || dist2D(home, e) > c.resRadius) continue;
      if (Loot.active && !Loot.active.petGid) {
        if (!Cmd.move(World.pose())) return false;
        Loot.suspend();
      }
      if (distance > Math.max(1, (skill.range || 150) - 5)) {
        if (!this.trip) this.trip = { phase: 'approach', member: m.id, gid: e.gid, name: e.name, home: { ...home },
          at: t, progressAt: t, lastPose: { ...World.pose() }, sentAt: -Infinity };
        return this.travelTick(skill, party);
      }
      if (!Cmd.select(e.gid)) return !!this.trip;
      if (!Cmd.skill(skill.id, e.gid)) return !!this.trip;
      if (this.trip) this.trip.phase = 'cast';
      Combat.lastCastAt = t; Combat.lastCastId = skill.id; Stats.count('casts');
      // Keep combat/loot movement from replacing the approach or cast before
      // the worker has published it. Continue holding any observed cast.
      this.holdUntil = t + Math.max(1000, skill.actionMs || 6000) + 500;
      this.nextAt = t + 700;
      const first = this.sent[m.id] === undefined;
      this.sent[m.id] = t;
      this.message = 'Resurrection offered: ' + m.name + '; waiting for the answer.';
      if (first) UI.toast('Resurrection offered: ' + m.name, 'info', 3000);
      return true;
    }
  },
};


// Native beta starter scroll: item 24198 -> skill 31107 (+100%, one hour).
// Never choose a paid scroll or infer consumption from a local command dispatch.
const SpeedScroll = {
  pending: null, attempts: 0, nextAt: 0, message: 'Speed scroll off.',
  reset() { this.pending = null; this.attempts = 0; this.nextAt = 0; this.message = 'Waiting for automation.'; },
  active() {
    if (World.buffRemaining(31107) > 0 || World.buffRemaining(5411) > 0) return true;
    const effects = [...(World.gp?.buffSlots || []).filter(b => b.state !== 'departing').map(b => b.effect), ...(World.gp?.attachedEffects || [])];
    return effects.some(e => e?.gid === World.localGid() && World.skill(e.skill)?.speedBuff?.active && World.buffRemaining(e.skill) > 0);
  },
  tick() {
    if (Town.trip) { this.message = 'Waiting for town services to finish.'; return false; }
    if (!Settings.profile.potion.speedScroll) { this.message = 'Speed scroll off.'; return false; }
    if (!World.inWorld() || World.isDead()) { this.message = 'Waiting for a living character in the world.'; return false; }
    if (this.active()) {
      this.pending = null; this.attempts = 0; this.nextAt = 0;
      this.message = 'Movement-speed buff active.'; return false;
    }
    if (!(Hunt.running || WalkBack.active || Restock.trip || Resurrect.trip)) { this.message = 'Waiting for hunting or travel.'; return false; }
    // Native inventory.use / useSkillItem installs this timed effect without
    // a combat cast. Waiting for World.isCasting() can starve it while hunting.
    const blocked = World.gp.inventoryPending ? 'Waiting for the inventory transaction to finish.' :
      World.gp.returnScroll ? 'Waiting for return-scroll travel.' :
      Resurrect.holdUntil > now() ? 'Waiting for the resurrection cast to finish.' :
      World.isSitting() ? 'Waiting for the character to stand.' :
      World.local()?.mountedOn ? 'Waiting for the character to dismount.' :
      Restock.activeShop() || World.gp.storage ? 'Waiting for the shop or storage to close.' :
      Restock.recording ? 'Waiting for route recording to finish.' :
      now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000 ? 'Waiting for the manual-control pause.' : '';
    if (blocked) { this.message = blocked; return false; }
    if (this.pending) {
      if (now() - this.pending.at < 8000) { this.message = 'Waiting for speed-buff confirmation.'; return false; }
      this.pending = null; this.nextAt = now() + 30000 * this.attempts;
      this.message = 'Speed buff was not confirmed. Backing off before retrying.';
      Log.warn(this.message);
    }
    if (this.attempts >= 3) { this.message = 'Speed buff not confirmed after 3 attempts. Check the game and toggle this option to retry.'; return false; }
    if (now() < this.nextAt) return false;
    const item = World.items().find(i => i.refObjId === 24198 && (i.quantity ?? 1) > 0);
    if (!item) { this.message = 'No beginner +100% speed scroll in your bag.'; return false; }
    if (!Cmd.itemUse(item.slot)) { this.message = 'Waiting for item-use availability (potions have priority).'; return false; }
    this.attempts++; this.pending = { at: now() };
    this.message = 'Beginner speed scroll requested; waiting for its buff.';
    return true;
  },
};


// Generated by gen-towns.py from the server data. Do not edit by hand.
const TOWN_TABLE = [{"key":"EU","name":"Constantinople","services":{"storage":{"refObjId":7503,"regionId":26959,"x":1348.9,"y":80.0,"z":845.88},"vendor":{"refObjId":7497,"regionId":26959,"x":1338.79,"y":84.09,"z":1400.89},"smith":{"refObjId":7495,"regionId":26959,"x":784.69,"y":83.46,"z":1532.71},"gate":{"refObjId":19074,"regionId":26959,"x":700.0,"y":80.0,"z":886.0}}},{"key":"WC","name":"Donwhang","services":{"storage":{"refObjId":2058,"regionId":26265,"x":1260.35,"y":-105.81,"z":696.9},"vendor":{"refObjId":2053,"regionId":26265,"x":597.25,"y":-106.46,"z":1134.97},"smith":{"refObjId":2051,"regionId":26265,"x":1197.69,"y":-106.67,"z":1217.7},"gate":{"refObjId":2095,"regionId":26521,"x":962.0,"y":-105.81,"z":8.0}}},{"key":"KT","name":"Hotan","services":{"storage":{"refObjId":2083,"regionId":23687,"x":1134.28,"y":243.75,"z":610.79},"vendor":{"refObjId":2074,"regionId":23687,"x":832.16,"y":243.86,"z":1093.64},"smith":{"refObjId":2072,"regionId":23687,"x":501.58,"y":243.58,"z":766.27},"gate":{"refObjId":2096,"regionId":23687,"x":1131.0,"y":243.75,"z":488.0}}},{"key":"CH","name":"Jangan","services":{"storage":{"refObjId":2014,"regionId":25000,"x":980.35,"y":-32.52,"z":989.19},"vendor":{"refObjId":2005,"regionId":25000,"x":1584.08,"y":0.0,"z":1407.29},"smith":{"refObjId":2003,"regionId":25000,"x":332.73,"y":0.0,"z":1406.7},"gate":{"refObjId":2094,"regionId":25000,"x":1254.0,"y":-32.52,"z":1374.0}}},{"key":"CA","name":"Samarkand","services":{"storage":{"refObjId":7537,"regionId":27244,"x":563.43,"y":180.0,"z":1131.66},"vendor":{"refObjId":7532,"regionId":27243,"x":1426.07,"y":180.0,"z":1851.0},"smith":{"refObjId":7530,"regionId":27499,"x":1762.61,"y":180.0,"z":809.78},"gate":{"refObjId":19075,"regionId":27499,"x":1917.0,"y":180.0,"z":108.0}}}];


// Town service owns the whole recall -> warehouse -> shop -> smith -> reverse trip.
// Native reverse scrolls are spent by travel-gate type 5/choice 2, not item-use.
const Town = {
  trip: null, lastScrollPoint: null, message: 'Town cycle off.',
  history: [], lastTrace: '',
  blocked() {
    if (!this.cfg().enabled) return 'town cycle is off';
    if (!Hunt.running) return 'bot is stopped';
    if (!World.inWorld() || !World.gp || !World.local()) return 'waiting for game world';
    if (World.isDead()) return 'character is dead';
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return 'manual control pause';
    if (WalkBack.active) return 'walk-back is active';
    if (Restock.recording) return 'recording a walking route';
    if (Restock.activeShop() || World.gp.storage) return 'close the open shop or storage';
    return '';
  },
  record(event = 'tick') {
    // Diagnostics must never prevent Stop or hide an engine error.
    try {
      const gp = World.gp, pet = Loot.pet();
      const row = { event, running: Hunt.running, mode: Controller.mode, phase: this.trip?.phase || '',
        trigger: this.reason(), blocked: this.trip ? '' : this.blocked(), message: this.message,
        inventoryPending: !!gp?.inventoryPending, casting: World.isCasting(), returnScroll: !!gp?.returnScroll,
        attempts: this.trip?.scrollAttempts || 0, accepted: !!this.trip?.scrollRequest?.accepted,
        freeBag: World.freeBagSlots(), petFree: pet ? pet.rec.status - pet.rec.inventory.length : null,
        hp: Potion.count('hp'), mp: Potion.count('mp'), error: gp?.error || '' };
      const key = JSON.stringify(row);
      if (key === this.lastTrace) return;
      this.lastTrace = key; this.history.push({ at: Date.now(), ...row });
      if (this.history.length > 120) this.history.shift();
    } catch {}
  },

  // Dispatch is not acknowledgement. Inventory-busy/cooldown refusals can
  // leave the worker without ever starting a scroll. Never resend an accepted
  // or unresolved inventory operation: native replies have no transaction ID.
  sentScroll(scroll, phase) {
    const request = { slot: scroll.slot, ref: scroll.refObjId, quantity: scroll.quantity ?? 1,
      state: World.gp, accepted: false, at: now() };
    this.trip.scrollAttempts = (this.trip.scrollAttempts || 0) + 1;
    this.enter(phase); this.trip.scrollRequest = request;
  },
  checkScroll() {
    const t = this.trip, r = t?.scrollRequest, gp = World.gp;
    if (!r || !gp) return false;
    const item = gp.inventory?.find(i => i.slot === r.slot && i.refObjId === r.ref);
    if (t.transition || gp.returnScroll || Array.isArray(gp.inventory) && (!item || (item.quantity ?? 1) < r.quantity)) r.accepted = true;
    if (r.accepted || now() - r.at < 5000) return false;
    if (/timed out|resynchron/i.test(gp.error || '')) {
      this.fail('Game inventory timed out; reconnect to resynchronize before restarting.'); return true;
    }
    // A new native snapshot must positively report the unchanged scroll and
    // idle inventory, otherwise its outcome is still unknown.
    if (gp === r.state || gp.inventoryPending !== false || !item || (item.quantity ?? 1) !== r.quantity || World.isCasting()) {
      this.message = 'Scroll not confirmed; waiting for fresh, settled game state.'; return true;
    }
    if (t.scrollAttempts >= 3) {
      this.fail('Return request was not accepted after three attempts. ' + (gp.error || 'Check game travel restrictions.')); return true;
    }
    const next = t.phase === 'recall-wait' ? 'recall' : 'reverse';
    this.enter(next); t.scrollRequest = null;
    if (next === 'recall') { t.haltSent = false; t.haltAttempts = 0; t.potionWindowReserved = true; }
    this.message = 'Scroll was not accepted; retrying automatically (' + (t.scrollAttempts + 1) + '/3).';
    return true;
  },
  cfg() { return Restock.cfg().town; },
  // Native X-Large HP/MP IDs 8/15, both authored with 50 potions per stack.
  supplies() { return Restock.supplies().map(s => ({ ...s, refObjId: s.kind === 'hp' ? 8 : s.kind === 'mp' ? 15 : s.refObjId })); },
  status() {
    if (this.trip || this.message.startsWith('Town cycle stopped:')) return this.message;
    if (!this.cfg().enabled) return 'Town cycle off. The pet-full chime is an alert; enable the scroll town cycle to return automatically.';
    if (!World.inWorld()) return 'Town cycle: waiting for game world.';
    const blocked = this.blocked();
    if (blocked) return 'Town return: ' + (this.reason() ? this.reason() + '; ' : '') + blocked + '.';
    const error = this.validate();
    return error ? 'Town cycle not ready: ' + error : 'Town cycle ready: waiting for low potions or character/pet bag capacity.';
  },
  scroll(type) { return World.items().find(i => (i.typeFlags & 0xfffc) === type && (i.quantity ?? 1) > 0); },
  free(items, start, end) {
    const used = new Set(items.map(i => i.slot));
    for (let slot = start; slot < end; slot++) if (!used.has(slot)) return slot;
    return null;
  },
  save(role) {
    if (Hunt.running || this.trip || Restock.recording || !World.inWorld()) return UI.toast('Stop hunting and route recording before saving town services.', 'warn');
    const c = this.cfg(), p = World.pose(), gp = World.gp;
    if (!p) return;
    if (role === 'arrival') c.arrival = { ...p };
    else {
      const npc = World.target(), cap = gp.targetCapabilities ?? 0;
      const required = { storage: 4, vendor: 1, smith: 8, gate: 0x80 }[role];
      if (!this.serviceEntity(role, npc) || gp.targetPending || !(cap & required)) return UI.toast(role === 'gate' ? 'Select the world statue / teleport in the game first.' : role === 'smith' ? 'Select a merchant that offers equipment repair in the game first.' : 'Select the appropriate town NPC in the game first.', 'warn');
      if (dist2D(p, npc) > 200) return UI.toast('Stand within 20 m of the NPC before saving its approach point.', 'warn');
      if (!c.arrival || dist2D(p, c.arrival) > 3000) return UI.toast('Save the town arrival point nearby first.', 'warn');
      if (role === 'vendor') {
        const shop = Restock.activeShop();
        if (!shop || shop.npc !== npc.gid) return UI.toast('Open this potion merchant shop before saving it.', 'warn');
        Restock.cfg().offers = shop.offers.filter(o => Restock.offerKind(o)).map(o => ({ refObjId: o.refObjId, name: o.name, kind: Restock.offerKind(o) }));
        for (const kind of ['hp', 'mp']) if (!Restock.cfg().offers.some(o => o.kind === kind && o.refObjId === Restock.cfg()[kind].refObjId)) Restock.cfg()[kind].refObjId = Restock.cfg().offers.find(o => o.kind === kind)?.refObjId || 0;
      }
      // Save the reachable place the user stands, rather than the NPC/model centre.
      c[role] = { ...p, refObjId: npc.refObjId, name: npc.name,
        npc: { regionId: npc.regionId, x: npc.x, y: npc.y, z: npc.z } };
    }
    this.message = 'Town setup updated.';
    Settings.saveProfile(); UI.toast('Saved town ' + role + '.'); UI.draw();
  },
  // Where each town's services stand, from the server data (see gen-towns.py).
  towns: TOWN_TABLE,
  // The known town whose four services all lie within 500 m of the position; the nearest overall wins.
  detect(point = World.pose()) {
    let best = null, bestTotal = Infinity;
    for (const town of this.towns) {
      const distances = Object.values(town.services).map(s => dist2D(point, s));
      if (distances.some(d => !(d <= 5000))) continue;
      const total = distances.reduce((a, b) => a + b, 0);
      if (total < bestTotal) { best = town; bestTotal = total; }
    }
    return best;
  },
  // A spot a few metres from the NPC on the side facing `from`: the NPC's own position is usually blocked. With
  // collision data for the area the spot must be walkable; without it the first choice is used and marked unverified.
  standPoint(npc, from) {
    const toward = regionDelta(npc, from) || [1, 0], base = Math.atan2(toward[1], toward[0]);
    let first = null;
    for (const distance of [40, 60, 80]) for (const turn of [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
      const angle = base + turn, x = npc.x + Math.cos(angle) * distance, z = npc.z + Math.sin(angle) * distance;
      const sx = Math.floor(x / SECTOR), sz = Math.floor(z / SECTOR);
      const point = { regionId: ((npc.regionId & 255) + sx) | (((npc.regionId >>> 8) + sz) << 8), x: x - sx * SECTOR, y: npc.y, z: z - sz * SECTOR };
      first ||= point;
      const local = Navigation.scene && Navigation.local(point);
      if (local && Navigation.open(local.x, local.z)) return { point, verified: true };
    }
    return { point: first, verified: false };
  },
  // Fills the arrival point and the four services from the town table. Only empty entries are filled unless
  // `overwrite` is set; an arrival point that belongs to another town replaces everything.
  autoSetup(overwrite = false) {
    if (Hunt.running || this.trip || Restock.recording || !World.inWorld()) { UI.toast('Stop hunting and route recording before setting up the town.', 'warn'); return null; }
    const c = this.cfg(), here = World.pose();
    if (!here) return null;
    const town = this.detect(here);
    if (!town) {
      this.message = 'Automatic setup: no known town around you. Use a return scroll, then press the button where it puts you.';
      UI.toast(this.message, 'warn', 6000); return null;
    }
    if (!(c.arrival && this.detect(c.arrival)?.key === town.key)) overwrite = true;
    const saved = [];
    if (overwrite || !c.arrival) { c.arrival = { ...here }; saved.push('arrival point'); }
    let unverified = 0;
    for (const [role, label] of [['storage', 'warehouse'], ['vendor', 'potion merchant'], ['smith', 'repair merchant'], ['gate', 'world statue']]) {
      if (c[role] && !overwrite) continue;
      const s = town.services[role], stand = this.standPoint(s, c.arrival);
      if (!stand.verified) unverified++;
      c[role] = { ...stand.point, refObjId: s.refObjId, name: town.name + ' ' + label,
        npc: { regionId: s.regionId, x: s.x, y: s.y, z: s.z } };
      saved.push(label);
    }
    this.message = saved.length ? `Automatic setup for ${town.name}: saved ${saved.join(', ')}.` + (unverified ? ' Walkable spots could not be checked without collision data; the first trip will tell.' : '')
      : `Automatic setup for ${town.name}: everything was already saved.`;
    Settings.saveProfile(); UI.toast(this.message, 'info', 6000); UI.draw();
    return { town: town.name, saved, unverified };
  },
  disposable(item) {
    const c = this.cfg(), name = (item.name || '').toLowerCase(), tf = item.typeFlags;
    // Missing type metadata must never turn an item into a disposal candidate; gear marked for deposit is never sold.
    if (!Number.isInteger(tf) || this.depositItem(item) || ItemType.isPotion(tf) || ItemType.isCure(tf) ||
        (tf & 0x7fc) === 0x1ec || item.refObjId === 24198 ||
        Restock.supplies().some(s => s.refObjId === item.refObjId) ||
        splitList(c.keep).some(s => name.includes(s))) return false;
    // Native rarity 2 covers seal tiers. Plus and blue options do not protect
    // ordinary gear; unknown rarity still means keep it rather than guess.
    if (ItemType.isEquipment(tf) && (![0, 1].includes(item.tooltip?.fields?.rarity) ||
        /_(RARE|MAGIC|LEGEND|MYTH)(?:_HONOR)?$/i.test(item.codename || ''))) return false;
    return true;
  },
  // Deposit-worthy gear: Star/Moon/Sun equipment from the character bag or the pickup pet.
  // "85" or "80-90, 100": the character levels whose gear is deposited. Anything unreadable is ignored.
  levelRanges() {
    return String(this.cfg().storeLevels ?? '').split(/[,;\s]+/).map(part => {
      const m = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(part);
      return m ? [Math.min(+m[1], +(m[2] ?? m[1])), Math.max(+m[1], +(m[2] ?? m[1]))] : null;
    }).filter(Boolean);
  },
  // Character level an equipment item requires, from its tooltip fields (type 1 = character level), or null.
  requiredLevel(item) {
    const f = item.tooltip?.fields;
    if (!f) return null;
    for (let i = 1; i <= 4; i++) {
      if (f['reqLevelType' + i] !== 1) continue;
      const level = f['requiredLevel' + (i === 1 ? '' : i)];
      return Number.isInteger(level) ? level : null;
    }
    return null;
  },
  // Gear to deposit: Star/Moon/Sun equipment, and equipment requiring a character level you listed. Gear the bot or
  // the player relies on stays put: names in Keep, a saved buff set's weapon or shield, and the weapon picked for
  // alchemy (checked by bag slot, so only for items from the character bag).
  depositItem(item, fromBag = false) {
    const c = this.cfg();
    if (!Number.isInteger(item.typeFlags) || !ItemType.isEquipment(item.typeFlags)) return false;
    const level = this.requiredLevel(item);
    if (!(c.storeSox && Items.soxOf(item) > 0) && !(level !== null && this.levelRanges().some(([a, b]) => level >= a && level <= b))) return false;
    if (splitList(c.keep).some(s => (item.name || '').toLowerCase().includes(s))) return false;
    const key = BuffGear.key(item);
    if (BuffGear.cfg().buffSets.some(s => s.weapon === key || s.shield === key)) return false;
    return !(fromBag && Alchemy.selected && Alchemy.selected.slot === item.slot);
  },
  // Loot kept in the warehouse instead of being sold. Stones are also deposited from the character bag; elixirs are
  // not, because alchemy takes them from there.
  kept: ['elixirs', 'magicStones', 'attrStones'],
  stone(item) { return this.disposable(item) && ['magicStones', 'attrStones'].includes(Loot.category(item.typeFlags)); },
  eligible(item) { return this.depositItem(item) || this.disposable(item) && this.kept.includes(Loot.category(item.typeFlags)); },
  sellable(item) { return this.disposable(item) && !this.kept.includes(Loot.category(item.typeFlags)); },
  autoRevive() { return this.cfg().enabled && this.cfg().revive; },
  reason() {
    const c = this.cfg(), pet = Loot.pet();
    if (World.freeBagSlots() <= 1) return 'character bag nearly full';
    if (c.petFull && pet && pet.rec.status - pet.rec.inventory.length <= c.petFree) return 'pickup pet nearly full';
    if (this.supplies().some(s => Restock.count(s.refObjId) <= s.low)) return 'potions running low';
    return '';
  },
  validate() {
    const c = this.cfg(), supplies = this.supplies();
    const missing = [['arrival', 'arrival point'], ['vendor', 'potion merchant'], ['smith', 'repair merchant'], ['gate', 'world statue / teleport'], ...(c.petFull ? [['storage', 'warehouse']] : [])].filter(([key]) => !c[key]).map(([, label]) => label);
    if (missing.length) return 'Save missing town services: ' + missing.join(', ') + '.';
    if (!supplies.length || supplies.some(s => !s.refObjId || !Number.isInteger(s.low) || !Number.isInteger(s.target) || s.low < 0 || s.target <= s.low || s.target > 10000)) return 'Choose potions and valid low-stock/refill quantities.';
    if (!this.scroll(0x09ec) || !this.scroll(0x19ec)) return 'Carry a return scroll and a reverse return scroll before hunting.';
    if (toBigInt(World.gp.progression?.gold ?? 0) <= 0n) return 'Carry gold for potions, storage and repairs.';
    return '';
  },
  fail(reason) {
    this.cancel(); this.message = 'Town cycle stopped: ' + reason;
    Hunt.stop(this.message); UI.toast(this.message, 'warn', 8000);
  },
  cancel() {
    if (this.trip && World.inWorld() && World.gp.returnScroll && ['recall-wait', 'reverse-wait'].includes(this.trip.phase)) Cmd.raw({ kind: 'return-cancel' }, 'Town: cancel return cast');
    this.trip = null;
  },
  phase(phase) {
    const t = this.trip;
    if (!t) return false;
    if (phase === 'entering-world' && ['recall-wait', 'reverse-wait'].includes(t.phase) && now() - t.at < 90000) {
      t.transition = true; return true;
    }
    if (phase !== 'world') this.fail('Unexpected travel or disconnect.');
    return false;
  },
  begin(revival = false) {
    const error = this.validate();
    if (error) return this.fail(error);
    const origin = revival ? this.lastScrollPoint || Hunt.cfg().center : World.pose();
    if (!origin) return this.fail('No saved hunting point for revival return.');
    if (revival) Hunt.running = true;
    Restock.trip = null;
    Resurrect.cancelTrip('', true); Resurrect.holdUntil = 0; Loot.suspend();
    this.trip = { phase: 'recall', at: now(), started: now(), origin: { ...origin }, revival,
      huntArea: revival && Hunt.cfg().center ? { center: { ...Hunt.cfg().center }, radius: Hunt.cfg().radius } : null,
      manualAt: Manual.lastAt, character: World.charName, petRef: Loot.pet()?.rec.refObjId,
      config: JSON.stringify(this.cfg()), supplies: this.supplies() };
    Hunt.targetGid = Hunt.lootGid = 0;
    // Stop the worker's repeating attack/movement as well as the bot's next tick.
    // Pending inventory work still settles before item-use is admitted below.
    this.trip.haltSent = Cmd.move(World.pose());
    this.trip.haltAt = now();
    this.trip.haltAttempts = this.trip.haltSent ? 1 : 0;
    if (revival) this.enter('revive-arrival');
    else this.message = 'Using return scroll; recall must be bound to your town.';
  },
  arrived() {
    this.trip.scrollAttempts = 0; this.trip.scrollRequest = null;
    if (World.freeBagSlots() < 1) return this.fail('Returned to town; free a character bag slot for storage and refills.');
    if (this.cfg().petFull && this.reason() === 'pickup pet nearly full' && !Loot.pet()?.rec.inventory.some(i => this.disposable(i) || this.eligible(i))) return this.fail('Returned to town; pet is full of protected items. Empty it manually.');
    this.enter(this.cfg().storage ? 'walk-storage' : 'walk-vendor');
  },
  enter(phase) {
    const t = this.trip;
    t.phase = phase; t.at = now(); t.sent = false; t.pending = null; t.transition = false;
    t.travel = null; t.lastPose = null; t.progressAt = now(); t.movedAt = -Infinity; t.retryAt = 0;
    this.message = 'Town cycle: ' + phase;
  },
  // Plain wording for the service being approached (never an NPC name), for messages and diagnostics.
  role(phase) { return { storage: 'warehouse', vendor: 'potion merchant', smith: 'repair merchant', gate: 'world statue' }[String(phase).replace(/^(walk|open|close)-/, '')] || 'service point'; },
  walk(dest) {
    const t = this.trip, pose = World.pose();
    // Permit a reachable nearby approach, but always stay in service range.
    const radius = Math.max(0, Math.min(60, 190 - dist2D(dest, dest.npc || dest)));
    if (dist2D(pose, dest) <= Math.max(12, radius) && dist2D(pose, dest.npc || dest) <= 200) return true;
    if (!Number.isFinite(dist2D(pose, dest))) { this.fail('Town service is in another world.'); return false; }
    if (!t.lastPose || dist2D(t.lastPose, pose) > 3) { t.lastPose = { ...pose }; t.progressAt = now(); }
    if (now() < t.retryAt) return false;
    if (now() - t.progressAt > 20000) {
      t.travel = null; t.retryAt = now() + 5000; t.progressAt = now();
      this.message = 'Town movement to the ' + this.role(t.phase) + ': blocked route (no progress for 20 s); retrying.';
      return false;
    }
    const step = Navigation.next(t, dest, false, radius);
    if (step.waiting || step.error) {
      t.travel = null; t.retryAt = now() + 5000; t.progressAt = now();
      this.message = 'Town movement to the ' + this.role(t.phase) + ': waiting; retrying collision route. ' + (step.error || 'Waiting for collision coverage.');
      return false;
    }
    this.message = 'Town cycle: walking to the ' + this.role(t.phase);
    if (!step.point || now() - t.movedAt < 1000 || World.gp.inventoryPending) return false;
    if (World.isSitting()) { if (Cmd.action(1000)) t.movedAt = now(); }
    else if (Cmd.move(step.point)) t.movedAt = now();
    return false;
  },
  serviceEntity(role, entity) { return !!entity && (entity.kind === 'npc' || role === 'gate' && entity.kind === 'teleport'); },
  npc(role) {
    const saved = this.cfg()[role];
    return [...World.ents.values()].find(e => this.serviceEntity(role, e) && e.refObjId === saved.refObjId && dist2D(e, saved.npc || saved) < 100);
  },
  open(role, kind) {
    const t = this.trip, gp = World.gp, npc = this.npc(role);
    if (now() - t.at > 15000) { this.fail('Could not open ' + role + '.'); return false; }
    if (!npc || gp.targetPending || gp.inventoryPending) return false;
    if (gp.target !== npc.gid) {
      if (t.sent) { this.fail('Town NPC selection changed.'); return false; }
      if (Cmd.spaced('select')) Cmd.select(npc.gid);
      return false;
    }
    const caps = { storage: 4, vendor: 1, smith: 8, gate: 0x20000000 };
    if (!(gp.targetCapabilities & caps[role])) { this.fail('Selected NPC does not offer ' + role + '.'); return false; }
    // Selection itself opens the service menu. npc-talk requires the separate
    // Talk capability and is invalid for teleport statues with no dialogue.
    if (role === 'gate') return gp.npcConversation?.phase === 'menu' && gp.npcConversation.gid === npc.gid;
    if (!t.sent) {
      t.revision = gp.shopCompletionRevision;
      if (Cmd.raw({ kind, ...(kind === 'npc-talk' ? {} : { gid: npc.gid }) }, 'Town: open ' + role)) t.sent = true;
      return false;
    }
    if (role === 'storage') return gp.storage?.phase === 'open' && !gp.storage.guild && gp.storage.npc === npc.gid;
    return gp.shop?.npc === npc.gid && gp.shopCompletionRevision !== t.revision;
  },
  close(next) {
    const t = this.trip, gp = World.gp;
    if (gp.inventoryPending) return;
    if (!t.sent) { if (Cmd.raw({ kind: 'npc-close' }, 'Town: close NPC')) t.sent = true; return; }
    if (!gp.target && !gp.storage) this.enter(next);
  },
  pendingDone(check) {
    const t = this.trip, p = t.pending;
    if (!p) return true;
    if (World.gp.inventoryPending || now() - p.at < 500) {
      if (now() - p.at > 15000) this.fail('Inventory transaction timed out. No repeat command sent.');
      return false;
    }
    if (check(p)) { t.pending = null; return true; }
    if (World.gp.error || now() - p.at > 15000) this.fail(World.gp.error || 'Transaction was not confirmed. No repeat command sent.');
    return false;
  },
  store() {
    const t = this.trip, gp = World.gp, st = gp.storage;
    if (!st || st.guild || st.phase !== 'open' || gp.target !== st.npc) return this.fail('Warehouse closed or selection changed.');
    const pet = Loot.pet();
    if (t.petRef && (!pet || pet.rec.refObjId !== t.petRef)) return this.fail('Pickup pet is missing or changed.');
    if (!this.pendingDone(p => {
      if (p.kind === 'pet') return !pet.rec.inventory.some(i => i.slot === p.source && i.refObjId === p.ref) && World.items().some(i => i.slot === p.destination && i.refObjId === p.ref && (i.quantity ?? 1) === p.quantity);
      return !World.items().some(i => i.slot === p.source && i.refObjId === p.ref) && st.items.some(i => i.slot === p.destination && i.refObjId === p.ref && (i.quantity ?? 1) === p.quantity);
    }) || !this.trip || gp.inventoryPending) return;
    const bagItem = t.staged ? World.items().find(i => i.slot === t.staged.slot && i.refObjId === t.staged.ref) : null;
    if (t.staged && !bagItem) return this.fail('Staged pet item changed unexpectedly.');
    // Gear the character picked up is deposited straight from the bag, then pet loot is staged through it.
    const bagSox = bagItem ? null : World.items().find(i => this.depositItem(i, true) || this.stone(i));
    const direct = bagItem || bagSox;
    const item = direct || pet?.rec.inventory.find(i => this.eligible(i));
    if (!item) {
      this.enter('close-storage'); return;
    }
    const destination = this.free(st.items, 0, st.capacity);
    if (destination === null) return this.fail('Storage is full.');
    let command, pending;
    if (direct) {
      command = { kind: 'storage-move', move: { type: 2, source: item.slot, destination, quantity: 0, gold: 0 } };
      pending = { kind: 'store', source: item.slot, destination, ref: item.refObjId, quantity: item.quantity ?? 1 };
    } else {
      const slot = this.free(gp.inventory, gp.equipmentSlotCount || 13, gp.inventorySlotCount);
      if (slot === null) return this.fail('No temporary character bag slot for pet transfer.');
      command = { kind: 'cos-transfer', gid: pet.rec.gid, toCos: false, source: item.slot, destination: slot };
      pending = { kind: 'pet', source: item.slot, destination: slot, ref: item.refObjId, quantity: item.quantity ?? 1 };
    }
    if (Cmd.raw(command, direct ? 'Town: deposit item' : 'Town: move selected pet loot')) {
      t.pending = { ...pending, at: now() };
      t.staged = direct ? null : { slot: pending.destination, ref: pending.ref };
    }
  },
  sell() {
    const t = this.trip, gp = World.gp, pet = Loot.pet();
    if (!Restock.activeShop() || gp.shop.npc !== this.npc('smith')?.gid || gp.shop.error) return this.fail(gp.shop?.error || 'Weapon merchant selection changed.');
    if (t.petRef && (!pet || pet.rec.refObjId !== t.petRef)) return this.fail('Pickup pet is missing or changed.');
    if (t.salePetGid && pet?.rec.gid !== t.salePetGid) return this.fail('Pickup pet changed during selling.');
    if (!this.pendingDone(p => !pet.rec.inventory.some(i => i.slot === p.source && i.refObjId === p.ref)) || !this.trip || gp.inventoryPending) return;
    const item = pet?.rec.inventory.find(i => this.sellable(i));
    if (!item) {
      if (this.cfg().petFull && pet && pet.rec.status - pet.rec.inventory.length <= this.cfg().petFree) return this.fail('Protected pet items still fill the bag.');
      this.enter('repair'); return;
    }
    const quantity = item.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 65535) return this.fail('Invalid pet item sale quantity.');
    if (Cmd.raw({ kind: 'cos-shop-sell', gid: pet.rec.gid, slot: item.slot, quantity }, 'Town: sell pet loot at weapon merchant')) {
      t.salePetGid = pet.rec.gid;
      t.pending = { source: item.slot, ref: item.refObjId, quantity, at: now() };
    }
  },
  buy() {
    const t = this.trip, gp = World.gp, shop = Restock.activeShop();
    if (!shop || shop.npc !== this.npc('vendor')?.gid || shop.error) return this.fail(shop?.error || 'Potion merchant selection changed.');
    if (!this.pendingDone(p => Restock.count(p.ref) >= p.before + p.quantity) || !this.trip || gp.inventoryPending) return;
    let s = t.supplies.find(s => Restock.count(s.refObjId) < s.target);
    if (!s) {
      // Refill held travel scrolls from gold offers only. Never buy from Item Mall.
      for (const type of [0x09ec, 0x19ec]) {
        const count = World.items().filter(i => (i.typeFlags & 0xfffc) === type).reduce((n, i) => n + (i.quantity ?? 1), 0);
        if (count >= 2) continue;
        const offer = shop.offers.find(o => (o.currency === undefined || o.currency === 1) &&
          (o.items || o.previews || []).some(i => i.refObjId === o.refObjId && (i.typeFlags & 0xfffc) === type) &&
          (!o.contents?.length || o.contents.length === 1 && o.contents[0].refObjId === o.refObjId && o.contents[0].quantity === 1));
        if (offer) { s = { kind: 'scroll', refObjId: offer.refObjId, target: Restock.count(offer.refObjId) + 2 - count }; break; }
        if (!count) return this.fail('Travel scrolls unavailable at this merchant. Carry spares.');
      }
    }
    if (!s) { this.enter('close-vendor'); return; }
    const offer = shop.offers.find(o => o.refObjId === s.refObjId && (s.kind === 'scroll' || Restock.offerKind(o) === s.kind));
    if (!offer || !(offer.maxStack > 0)) return this.fail(s.kind === 'scroll' ? 'Selected scroll is unavailable here.' : s.kind === 'cure' ? 'Special Universal Pill (small) is unavailable here.' : s.kind === 'vigor' ? 'The selected vigor potion size is unavailable here; choose another size in Supplies.' : 'X-Large ' + s.kind.toUpperCase() + ' potion is unavailable here.');
    const before = Restock.count(s.refObjId), room = World.items().filter(i => i.refObjId === s.refObjId).reduce((n, i) => n + Math.max(0, offer.maxStack - (i.quantity ?? 1)), 0);
    const quantity = Math.min(s.target - before, offer.purchaseLimit ?? offer.maxStack, 65535, room + Math.max(0, World.freeBagSlots() - 1) * offer.maxStack);
    if (quantity < 1) return this.fail('Not enough bag space for refill and a spare transfer slot.');
    if (gp.progression?.gold === undefined || toBigInt(offer.price) * BigInt(quantity) > toBigInt(gp.progression.gold)) return this.fail('Not enough gold for potion refill.');
    if (Cmd.raw({ kind: 'shop-buy', tab: offer.tab, slot: offer.slot, quantity }, 'Town: refill ' + s.kind)) t.pending = { ref: s.refObjId, before, quantity, at: now() };
  },
  maximum(item) {
    const f = item.tooltip?.fields;
    if (!f || !Number.isFinite(f.varianceIntMin1c0) || !Number.isFinite(f.varianceIntMax1c4) || item.variance === undefined) return null;
    const base = Math.trunc((f.varianceIntMax1c4 - f.varianceIntMin1c0) * Number(toBigInt(item.variance) & 31n) / 31 + f.varianceIntMin1c0 + .5);
    if (!base) return 0;
    let pct = 0;
    for (const encoded of item.magic || []) {
      const bits = toBigInt(encoded), r = item.magicReferences?.find(r => r.paramId === Number(bits & 65535n)), amount = Number(bits >> 32n) & 0xffffffff;
      if (!r) continue;
      if (r.optionName === 'MATTR_DUR' && r.paramName.includes('+')) pct += amount;
      if (r.optionName === 'MATTR_DEC_MAXDUR' && r.paramName.includes('-')) pct -= amount;
      if (r.optionName === 'MATTR_NOT_REPARABLE' && r.paramName.includes('-')) pct += r.rangeWords?.[1] ?? 0;
    }
    return Math.max(1, base + Math.trunc(base * pct / 100));
  },
  damaged() {
    const result = [];
    for (const i of World.gp.inventory || []) {
      if (!ItemType.isEquipment(i.typeFlags) || i.durability === undefined) continue;
      if (!i.tooltip?.fields) throw Error('Missing equipment repair metadata.');
      if (!i.tooltip.fields.canRepair) continue;
      const max = this.maximum(i);
      if (max === null) throw Error('Missing equipment maximum durability.');
      if (i.durability < max) result.push({ slot: i.slot, ref: i.refObjId, max });
    }
    return result;
  },
  repair() {
    const t = this.trip, gp = World.gp;
    if (!Restock.activeShop() || gp.shop.npc !== this.npc('smith')?.gid) return this.fail('Smith selection changed.');
    if (!t.sent) {
      const damaged = this.damaged();
      if (!damaged.length) return this.enter('close-smith');
      if (Cmd.raw({ kind: 'shop-repair', mode: 2, slot: 0 }, 'Town: repair equipment')) { t.sent = true; t.repairs = damaged; }
      return;
    }
    if (gp.inventoryPending || now() - t.at < 1000) return;
    if (t.repairs.every(r => gp.inventory.some(i => i.slot === r.slot && i.refObjId === r.ref && i.durability >= r.max))) this.enter('close-smith');
    else if (now() - t.at > 15000) this.fail('Repairs were not confirmed. Check gold and repair restrictions.');
  },
  tick() {
    const c = this.cfg();
    if (!this.trip) {
      if (this.blocked() || !this.reason()) return false;
      this.begin();
      if (!this.trip) return true;
    }
    const t = this.trip, gp = World.gp;
    if (!c.enabled || !Hunt.running || t.character !== World.charName || t.config !== JSON.stringify(c)) { this.fail('Settings or character changed during the trip.'); return true; }
    if (Manual.lastAt !== t.manualAt) { this.fail('Manual control interrupted the trip.'); return true; }
    // Movement may wait indefinitely for collision coverage. Individual service
    // and transaction phases still enforce their own confirmation timeouts.
    if (['recall-wait', 'reverse-wait', 'revive-arrival'].includes(t.phase) && now() - t.at > 90000) { this.fail('Scroll arrival timed out.'); return true; }
    if (!World.inWorld() || !gp?.pose || !World.local()) return true;
    if (World.isDead()) { this.fail('Character died during town service.'); return true; }
    if (['recall-wait', 'reverse-wait'].includes(t.phase) && this.checkScroll()) return true;
    if (t.phase === 'recall' && now() - t.at > 30000) { this.fail('Combat or inventory did not settle before departure.'); return true; }
    // Stopping combat is part of departure, not a best-effort side effect.
    // The initial move may hit Cmd.move's 550 ms rate limit or pending queue.
    // Retry it before waiting for a cast that the worker otherwise repeats.
    if (t.phase === 'recall' && (!t.haltSent || World.isCasting() && now() - t.haltAt >= 1500 && t.haltAttempts < 3)) {
      if (Cmd.move(World.pose())) { t.haltSent = true; t.haltAt = now(); t.haltAttempts++; }
      this.message = 'Town departure: stopping combat before using the return scroll.';
      return true;
    }
    // Arrival confirmation sends no command, so emergency potions cannot
    // keep the controller trapped in travel after the character has arrived.
    if (!['recall-wait', 'reverse-wait', 'revive-arrival'].includes(t.phase) && now() - Potion.lastUse < 350) return true;
    Hunt.state = 'restock';
    if (t.phase === 'recall') {
      if (World.isCasting() || gp.inventoryPending) {
        this.message = 'Town departure reserved; waiting for combat or inventory to settle.';
        return true;
      }
      if (World.isSitting()) { if (Cmd.spaced('action')) Cmd.action(1000); return true; }
      if (World.local()?.mountedOn) { this.fail('Dismount before starting town service.'); return true; }
      const scroll = this.scroll(0x09ec);
      if (!scroll) { this.fail('Return scroll missing.'); return true; }
      if (Cmd.itemUse(scroll.slot)) this.sentScroll(scroll, 'recall-wait');
    } else if (t.phase === 'revive-arrival') {
      if (!gp.inventoryPending && !gp.returnScroll && dist2D(World.pose(), c.arrival) <= clamp(Number(c.arrivalRadius) || 500, 100, 1500)) this.arrived();
      else this.message = 'Waiting for revival at the saved town arrival area.';
    } else if (['recall-wait', 'reverse-wait'].includes(t.phase)) {
      const radius = t.phase === 'recall-wait' ? clamp(Number(c.arrivalRadius) || 500, 100, 1500) : 300;
      // The scroll always lands on the same spot. If the saved arrival point is not it (saved where you happened to
      // stand, say), adopt the spot the character settled on after a confirmed trip, but only in the saved services' town.
      if (t.phase === 'recall-wait' && t.transition && dist2D(World.pose(), c.arrival) > radius && !gp.inventoryPending && !gp.returnScroll) {
        const here = World.pose(), town = this.detect(here), saved = this.detect(c.vendor || c.storage || c.arrival);
        if (!town || !saved || town.key !== saved.key) t.landed = null;
        else if (!t.landed || dist2D(t.landed.pose, here) > 3) t.landed = { pose: { ...here }, at: now() };
        else if (now() - t.landed.at >= 3000) {
          c.arrival = { ...here }; t.config = JSON.stringify(c); t.landed = null; Settings.saveProfile();
          Log.info('Town arrival point updated to where the return scroll landed.');
        }
      }
      const dest = t.phase === 'recall-wait' ? c.arrival : t.origin;
      const distance = dist2D(World.pose(), dest);
      // After death the game's last scroll point need not equal the saved
      // hunt center (or an older remembered scroll point). Accept the saved
      // hunting area too, but only after confirmed, settled world travel.
      const inHuntArea = t.phase === 'reverse-wait' && t.revival && t.huntArea &&
        dist2D(World.pose(), t.huntArea.center) <= t.huntArea.radius;
      if (t.transition && (distance <= radius || inHuntArea) && !gp.inventoryPending && !gp.returnScroll) {
        if (t.phase === 'recall-wait') { this.lastScrollPoint = { ...t.origin }; this.arrived(); }
        else {
          this.lastScrollPoint = { ...World.pose() };
          this.trip = null; Hunt.targetGid = Hunt.lootGid = 0; Hunt.state = 'search';
          this.message = 'Town service complete; hunting resumed.'; UI.toast(this.message);
        }
      } else {
        this.message = !t.transition ? (t.scrollRequest?.accepted ? 'Scroll accepted by game; waiting for travel.' : 'Waiting for game to accept the scroll request.') : gp.inventoryPending || gp.returnScroll
          ? 'Waiting for scroll arrival state to settle.'
          : 'Waiting for arrival area: ' + (Number.isFinite(distance) ? Math.round(distance / 10) + ' m from saved point; tolerance ' + Math.round(radius / 10) + ' m.' : 'saved point is in another world.');
      }
    } else if (t.phase.startsWith('walk-')) {
      const role = t.phase.slice(5);
      if (this.walk(c[role]) && this.trip) this.enter('open-' + role);
    } else if (t.phase.startsWith('open-')) {
      const role = t.phase.slice(5), kind = role === 'storage' ? 'storage-open' : role === 'gate' ? 'npc-talk' : 'shop-open';
      if (this.open(role, kind) && this.trip) this.enter({ storage: 'store', vendor: 'buy', smith: 'sell', gate: 'reverse' }[role]);
    } else if (t.phase === 'store') this.store();
    else if (t.phase === 'buy') this.buy();
    else if (t.phase === 'sell') this.sell();
    else if (t.phase === 'repair') this.repair();
    else if (t.phase.startsWith('close-')) {
      if (now() - t.at > 15000) this.fail('NPC window did not close.');
      else this.close({ 'close-storage': 'walk-vendor', 'close-vendor': 'walk-smith', 'close-smith': 'walk-gate' }[t.phase]);
    } else if (t.phase === 'reverse') {
      if (gp.inventoryPending || World.isCasting()) return true;
      if (t.supplies.some(s => Restock.count(s.refObjId) < s.target) || this.damaged().length || !this.scroll(0x09ec) || !this.scroll(0x19ec)) { this.fail('Final supply, repair or travel-scroll check failed.'); return true; }
      if (World.freeBagSlots() <= 1) { this.fail('Returned to town; free at least two character bag slots before hunting again.'); return true; }
      const npc = this.npc('gate');
      if (!npc || gp.target !== npc.gid || !(gp.targetCapabilities & 0x20000000)) { this.fail('Reverse-return teleport NPC unavailable.'); return true; }
      const scroll = this.scroll(0x19ec);
      if (Cmd.raw({ kind: 'travel-gate', gid: npc.gid, type: 5, target: 2 }, 'Town: reverse to last return-scroll point')) this.sentScroll(scroll, 'reverse-wait');
    }
    return true;
  },
};


// Confirm every native inventory move before casting or restoring combat gear.
const BuffGear = {
  run: null, recovery: null, message: 'Buff weapon swapping off.', skipped: new Map(), started: false,
  cfg() { return Settings.profile.macro; },
  items() { return World.gp?.inventory || []; },
  at(slot) { return this.items().find(i => i.slot === slot) || null; },
  key(i) { return i ? JSON.stringify([i.refObjId, i.typeFlags, i.plus ?? 0, i.variance ?? null, i.magic ?? null]) : null; },
  weapon(i) { return i && (i.typeFlags & 0x7e) === 0x2c && (i.typeFlags >>> 7 & 15) === 6; },
  shield(i) { return i && (i.typeFlags & 0x1e) === 0x0c && (i.typeFlags >>> 7 & 15) === 4; },
  find(key) {
    if (!key) return null;
    const matches = this.items().filter(i => this.key(i) === key);
    return matches.length === 1 ? matches[0] : null;
  },
  setup() { return { weapon: this.key(this.at(6)), shield: this.key(this.at(7)) }; },
  matches(set) { return set.weapon === this.key(this.at(6)) && set.shield === this.key(this.at(7)); },
  signature() { return JSON.stringify([this.cfg().buffSwap, this.cfg().buffSets, this.cfg().buffs]); },
  init() {
    if (this.started) return;
    this.started = true;
    Hook.observers.push(command => {
      if (command.kind === 'gameplay' && command.command?.kind === 'inventory-move' && this.run) this.fail('Manual equipment move interrupted buff swaps.');
    });
    bus.on('cast', c => {
      const p = this.run?.cast;
      if (p && c.caster === World.localGid() && c.skill === p.id && !c.resultOnly && c.cancelledAtMs === undefined) p.accepted = true;
    });
  },
  save(name) {
    if (this.run || this.recovery || Hunt.running || World.gp?.inventoryPending || !World.inWorld()) return UI.toast('Stop hunting and settle gear restoration first.', 'warn');
    const set = this.setup();
    if (!this.weapon(this.at(6)) || this.at(7) && !this.shield(this.at(7))) return UI.toast('Equip a buff weapon and an optional shield first. Remove arrows or bolts from the off-hand slot.', 'warn');
    if (!this.find(set.weapon) || set.shield && !this.find(set.shield)) return UI.toast('Identical gear cannot be distinguished. Keep only one matching copy.', 'warn');
    const sets = this.cfg().buffSets;
    if (sets.length >= 8) return UI.toast('Up to eight buff sets can be saved.', 'warn');
    sets.push({ ...set, id: Math.max(0, ...sets.map(s => Number(s.id) || 0)) + 1, name: String(name || 'Buff set').trim().slice(0, 40) || 'Buff set' });
    Settings.saveProfile(); UI.draw();
  },
  reset() {
    this.run = this.recovery = null; this.skipped.clear();
    this.message = 'Buff gear reset. Check equipped weapons after reconnecting.';
  },
  interrupt(text) {
    if (this.run) this.fail(text);
  },
  fail(text) {
    if (this.run) this.recovery = this.run.home;
    this.run = null;
    if (Hunt.running && World.inWorld() && !World.isDead()) Hunt.stop(text);
    else Hunt.running = false;
    this.message = text + ' Check gear or use Restore combat gear.';
    UI.toast(this.message, 'warn');
  },
  cancel() {
    if (!this.run) return;
    this.run.restoring = true; this.run.queue = []; this.run.cancelled = true;
    this.message = 'Stopping buffs; restoring combat gear.';
  },
  restore() {
    if (this.run || !this.recovery || !World.inWorld() || World.isDead() || World.gp?.inventoryPending || World.isCasting()) return;
    if (Hunt.running || Town.trip || WalkBack.active || Restock.trip || Alchemy.run || Alchemy.pending) return UI.toast('Stop hunting and travel before restoring gear.', 'warn');
    this.run = this.create(this.recovery, []); this.run.restoring = true; this.recovery = null;
  },
  create(home, queue) {
    return { home, queue, restoring: false, pending: null, cast: null, effects: [],
      at: now(), manualAt: Manual.lastAt, character: World.charName, profile: Settings.profile, signature: this.signature() };
  },
  due(b) {
    if (!b.enabled || !b.gearSet) return 0;
    const id = Combat.resolve(b), info = World.skill(id);
    if (!id || !info || info.targetRequired || Combat.blocked(id) || !Cmd.canCast(id) || !Combat.mpOk(id, World.me())) return 0;
    if (this.skipped.get(b.group) === this.signature()) return 0;
    const remaining = World.buffRemaining(id);
    if (remaining > (b.refreshS ?? 3) * 1000) return 0;
    const gap = Math.max(4000, Math.min((info?.durationMs || 20000) * .85, 600000));
    return now() - (Combat.buffCastAt.get(b.group) ?? -Infinity) >= gap ? id : 0;
  },
  begin() {
    if (!this.cfg().buffSwap || this.recovery || !Hunt.running || !World.inWorld() || World.isDead() ||
        Combat.busy() || World.isSitting() || World.local()?.mountedOn || World.gp?.inventoryPending ||
        World.gp?.pendingMoves || World.gp?.returnScroll || now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000 ||
        Town.trip || WalkBack.active || Restock.trip || Restock.recording || Resurrect.trip || now() < Resurrect.holdUntil ||
        Restock.activeShop() || World.gp?.storage || World.gp?.exchange?.open || World.gp?.exchange?.requesting || World.gp?.stall?.phase && World.gp.stall.phase !== 'none' ||
        Alchemy.run || Alchemy.pending || Loot.active && !Loot.active.petGid || Loot.pressed()) return false;
    const queue = [];
    for (const set of this.cfg().buffSets) {
      const buffs = this.cfg().buffs.filter(b => Number(b.gearSet) === set.id).map(b => ({ b, id: this.due(b) })).filter(b => b.id);
      if (buffs.length) queue.push({ set, buffs });
    }
    if (!queue.length) return false;
    const home = this.setup();
    if (!this.weapon(this.at(6))) { this.message = 'Equip your combat weapon before hunting.'; return false; }
    for (const set of [home, ...queue.map(q => q.set)]) {
      if (!this.find(set.weapon) || !this.weapon(this.find(set.weapon)) || set.shield && (!this.find(set.shield) || set !== home && !this.shield(this.find(set.shield)))) {
        this.message = 'Buff gear missing or ambiguous. Save the sets again.'; return false;
      }
    }
    // One free bag slot permits explicit shield removal before two-handed swaps.
    if (World.freeBagSlots() < 1) { this.message = 'Buff swaps need one free bag slot.'; return false; }
    if (!Cmd.move(World.pose())) return false;
    Loot.suspend(); Hunt.state = 'buff'; this.run = this.create(home, queue);
    this.message = 'Pausing combat for buff gear.';
    return true;
  },
  move(source, destination) {
    const r = this.run, from = this.key(this.at(source)), to = this.key(this.at(destination));
    if (!from || !Cmd.spaced('inventory-move')) return;
    if (Cmd.raw({ kind: 'inventory-move', source, destination, quantity: 0 }, 'Buff gear: move equipment')) {
      r.pending = { source, destination, from, to, at: now() };
    }
  },
  equip(set) {
    if (this.matches(set)) return true;
    const weapon = this.find(set.weapon), shield = this.find(set.shield);
    if (!weapon || !this.weapon(weapon) || set.shield && (!shield || set !== this.run.home && !this.shield(shield))) { this.fail('Required equipment missing or ambiguous.'); return false; }
    if (this.at(7) && this.key(this.at(7)) !== set.shield) {
      const gp = World.gp;
      let empty = -1;
      for (let slot = gp.equipmentSlotCount || 13; slot < gp.inventorySlotCount; slot++) if (!this.at(slot)) { empty = slot; break; }
      if (empty < 0) { this.fail('No bag space to remove the off-hand item.'); return false; }
      this.move(7, empty); return false;
    }
    if (weapon.slot !== 6) { this.move(weapon.slot, 6); return false; }
    if (shield && shield.slot !== 7) { this.move(shield.slot, 7); return false; }
    return false;
  },
  tick() {
    if (!this.run) return this.begin();
    const r = this.run, gp = World.gp;
    if (r.character !== World.charName || r.profile !== Settings.profile) { this.reset(); return false; }
    if (!World.inWorld() || World.isDead()) { this.interrupt('World change or death interrupted buff swaps.'); return false; }
    if (Manual.lastAt !== r.manualAt) { this.fail('Manual control interrupted buff swaps.'); return true; }
    if (now() - r.at > 120000) { this.fail('Buff gear cycle timed out.'); return true; }
    if (!Hunt.running || r.signature !== this.signature()) this.cancel();
    if (r.pending) {
      const p = r.pending;
      if (!gp.inventoryPending && this.key(this.at(p.destination)) === p.from && this.key(this.at(p.source)) === p.to) r.pending = null;
      else { if (now() - p.at > 15000) this.fail('Equipment move unconfirmed; no retry sent.'); return true; }
    }
    if (r.cast) {
      const p = r.cast, remaining = World.buffRemaining(p.id);
      if (remaining > 0) { p.accepted = true; p.visible = true; }
      if (now() < p.until || World.isCasting()) return true;
      if (!p.accepted) { if (now() - p.at > 10000) { this.skipped.set(p.group, r.signature); this.cancel(); this.message = 'Buff cast unconfirmed; restoring combat gear.'; r.cast = null; } return true; }
      r.effects.push(p); r.cast = null;
    }
    if (Combat.busy() || gp.inventoryPending || World.isSitting() || World.local()?.mountedOn || Loot.pressed()) return true;
    if (Restock.activeShop() || gp.storage || gp.exchange?.open || gp.exchange?.requesting || gp.stall?.phase && gp.stall.phase !== 'none' || gp.returnScroll) { this.fail('Buff swaps interrupted by another game action.'); return true; }
    if (r.restoring || !r.queue.length) {
      this.message = 'Restoring combat gear.';
      if (!this.equip(r.home)) return true;
      if (!r.restoredAt) { r.restoredAt = now(); return true; }
      if (now() - r.restoredAt < 1000) return true;
      for (const p of r.effects) if (p.visible && World.buffRemaining(p.id) <= 0) {
        this.skipped.set(p.group, r.signature);
        this.message = 'A buff ended after changing weapons; skipped until buff settings change.';
      }
      if (this.message === 'Restoring combat gear.') this.message = 'Combat gear restored.';
      this.run = null; this.recovery = null; return true;
    }
    const q = r.queue[0];
    this.message = 'Equipping ' + q.set.name + ' for buffs.';
    if (!this.equip(q.set)) return true;
    const entry = q.buffs[0];
    if (!entry) { r.queue.shift(); return true; }
    if (!this.due(entry.b)) { q.buffs.shift(); return true; }
    if (Combat.cast(entry.id, 0)) {
      Combat.buffCastAt.set(entry.b.group, now()); q.buffs.shift();
      r.cast = { id: entry.id, group: entry.b.group, at: now(), until: now() + Math.max(1000, World.skill(entry.id)?.actionMs || 6000) + 500, accepted: false, visible: false };
      this.message = 'Casting buff; waiting before changing weapons.';
    }
    return true;
  },
  status() {
    if (this.run || this.recovery || this.skipped.size) return this.message;
    return this.cfg().buffSwap ? 'Buff weapon sets ready; used while hunting.' : 'Buff weapon swapping off.';
  },
  draw(parent) {
    const box = UI.group('Buff weapon sets');
    box.append(UI.check('Swap weapons for assigned buffs', () => this.cfg().buffSwap, v => this.cfg().buffSwap = v),
      el('p', 'Equip a buff weapon and optional shield, save the set, then put your combat gear back on. Assign each buff below to its set. Multiple sets run in turn while hunting; original combat gear is restored afterward. Keep one bag slot free. Buffs tied to the removed weapon may end.', 'muted'));
    const name = el('input'); name.type = 'text'; name.maxLength = 40; name.value = 'Buff set ' + (this.cfg().buffSets.length + 1);
    box.append(UI.field('New buff set name', name), UI.button('Save equipped buff set', () => this.save(name.value)));
    for (const set of this.cfg().buffSets) {
      const weapon = this.find(set.weapon), shield = this.find(set.shield);
      box.append(UI.row(el('span', set.name + ': ' + (weapon?.name || (weapon ? 'Weapon +' + (weapon.plus || 0) : 'weapon missing / ambiguous')) + (set.shield ? shield ? ' + shield' : ' + shield missing / ambiguous' : '')),
        UI.button('Remove ' + set.name, () => {
          if (this.run || this.recovery) return UI.toast('Restore combat gear before editing sets.', 'warn');
          this.cfg().buffSets = this.cfg().buffSets.filter(s => s.id !== set.id);
          for (const b of this.cfg().buffs) if (Number(b.gearSet) === set.id) b.gearSet = 0;
          Settings.saveProfile(); UI.draw();
        })));
    }
    box.append(UI.button('Restore combat gear', () => this.restore()), UI.button('Use current gear', () => {
      if (this.run || World.gp?.inventoryPending) return UI.toast('Wait for the current equipment move to settle.', 'warn');
      this.recovery = null; this.message = 'Current gear accepted. Review it before hunting.';
    }));
    this.note = el('p', this.status(), 'muted'); box.append(this.note); parent.append(box);
  },
};
const normalBuffs = Combat.buffs;
Combat.buffs = function (hunting) {
  // Assigned buffs are owned exclusively by the gear cycle, including when off.
  const original = Settings.profile.macro.buffs;
  Settings.profile.macro.buffs = original.filter(b => !b.gearSet);
  try { return normalBuffs.call(this, hunting); }
  finally { Settings.profile.macro.buffs = original; }
};


// Single owner for movement/combat/pickup. Potion use remains a separate emergency lane.
const startHunting = Hunt.start;
Hunt.start = function (...args) {
  if (BuffGear.run || BuffGear.recovery) return UI.toast('Restore or review combat gear before hunting.', 'warn');
  if (Alchemy.run || Alchemy.pending) return UI.toast('Stop alchemy and wait for its result before hunting.', 'warn');
  return startHunting.apply(this, args);
};
Hunt.lootAllowed = e => Loot.allowed(e);
Hunt.chooseLoot = () => Loot.choose();
Hunt.tick = function () {
  if (!this.running) return;
  if (!Town.cfg().enabled && Restock.tick()) { Loot.suspend(); return; }
  const H = this.cfg(), gp = World.gp;
  if (!World.inWorld()) { this.state = 'waiting'; return; }
  if (World.isDead()) {
    Loot.suspend();
    this.state = 'dead';
    if (!this.deathAt) { this.deathAt = now(); Party.noteDeath(); }
    if ((Town.autoRevive() || H.onDeath === 'revive') && !this.revived && now() - this.deathAt > Party.reviveDelay() && !Party.resBusy()) {
      if (Cmd.rebirth(1)) this.revived = true;
    } else if (!Town.autoRevive() && H.onDeath === 'stop') this.stop('character died');
    return;
  }
  if (this.deathAt) {
    this.deathAt = 0; this.revived = false; this.targetGid = 0;
    if (H.center && dist2D(World.pose(), H.center) > H.radius) { Controller.returnAfterRevive(); return; }
  }
  if (Restock.activeShop() || gp.storage || now() - Manual.lastAt < H.manualPauseS * 1000) {
    Loot.suspend(); this.state = 'manual'; return;
  }
  if (this.playerCheck()) { Loot.suspend(); this.state = 'player'; return; }
  if (H.stopNoHpPotion && Potion.count('hp') + Potion.count('vigor') === 0) return this.stop('out of HP potions');
  if (H.stopInvFull && World.freeBagSlots() === 0) return this.stop('inventory full');
  Loot.preparePet();
  const attacked = this.underAttack(), current = this.currentTarget();
  if (Loot.petMode()) {
    // Pet movement does not own the character's combat tick.
    if (Loot.active) Loot.tick();
    if (!Loot.active && H.pickup.enabled) {
      const drop = Loot.choose();
      if (drop) Loot.begin(drop);
    }
  } else {
    if (attacked) Loot.suspend();
    // Character pickup owns movement until done or interrupted by an attacker.
    if (!attacked && Loot.active && Loot.tick()) return;
    if (H.pickup.enabled && !attacked && (!current || !H.pickup.afterKillOnly) && !World.isSitting()) {
      const drop = Loot.choose();
      if (drop && Loot.begin(drop)) { this.state = 'loot'; return; }
    }
  }
  const me = World.me();
  if (World.isSitting()) {
    const done = !H.sit.enabled || me.hpPct >= H.sit.resumeAt && me.mpPct >= H.sit.resumeAt;
    this.state = done || attacked ? 'standing' : 'resting';
    if ((done || attacked) && now() - this.sitToggleAt > 2500 && Cmd.action(1000)) this.sitToggleAt = now();
    return;
  }
  if (H.sit.enabled && !attacked && !current && (me.hpPct < H.sit.hpBelow || me.mpPct < H.sit.mpBelow)) {
    if (now() - this.sitToggleAt > 2500 && Cmd.action(1000)) this.sitToggleAt = now();
    this.state = 'resting'; return;
  }
  if (Combat.buffs(true)) { this.state = 'buff'; return; }
  const target = current || this.chooseTarget();
  if (target) { this.engage(target); return; }
  this.targetGid = 0; this.state = Loot.active?.petGid ? 'loot' : 'search';
  if (H.returnToCenter && H.center && dist2D(World.pose(), H.center) > Math.max(40, H.radius * 0.5) && now() - this.lastMoveAt > 2500) {
    if (!Number.isFinite(dist2D(World.pose(), H.center))) return this.stop('hunt area is in another region');
    if (Cmd.move(H.center)) this.lastMoveAt = now();
    this.state = 'return';
  }
};

function stopAll() {
  Town.record('stop');
  Alchemy.stop();
  BuffGear.cancel();
  const townActive = !!Town.trip;
  Town.cancel();
  Resurrect.cancelTrip('', true);
  Resurrect.holdUntil = 0;
  Controller.resumeAfterRevive = false;
  const active = townActive || Hunt.running || Restock.trip || WalkBack.active || Loot.active;
  WalkBack.cancel('', false);
  if (Hunt.running) Hunt.stop();
  Restock.trip = null;
  Loot.suspend();
  if (active && World.inWorld() && !World.isDead()) Cmd.move(World.pose());
}

// Berserk fires when the gauge is full and the target's class is ticked in Combat options.
Combat.berserk = function (cls) {
  if (!Settings.profile.macro.berserkClasses?.[cls] || World.berserkGauge < 5) return false;
  if (World.local()?.appearanceState?.[2] === 1) return false;
  return Cmd.berserk();
};
const Controller = {
  mode: 'idle', lastErrorAt: -Infinity, resumeAfterRevive: false, guardAt: {},
  // Optional features must never stop hunting: an error in one is logged (at most every 5 s) and skipped.
  guard(name, fn) {
    try { return fn(); } catch (e) {
      if (now() - (this.guardAt[name] ?? -Infinity) > 5000) { this.guardAt[name] = now(); Log.error(name + ' error: ' + (e?.message || e)); }
      return false;
    }
  },
  // Start hunting again after an interruption, but only where that is safe: at the hunting spot it just starts, a
  // little way off (within 600 m) it walks back first, anywhere else it stays stopped. Returns 'started', 'walking' or 'stopped'.
  resumeHunting(prefix) {
    const H = Hunt.cfg(), pose = World.pose(), distance = H.center && pose ? dist2D(pose, H.center) : Infinity;
    if (Number.isFinite(distance) && distance <= Math.max(H.radius * 1.5, 600)) { UI.toast(prefix + '; resuming hunting.', 'info', 4000); Hunt.start(); return 'started'; }
    if (distance <= 6000) { UI.toast(prefix + '; walking back to the hunting spot.', 'info', 4000); WalkBack.start(true); return 'walking'; }
    UI.toast(prefix + ', but not at the hunting spot. Use Return & hunt when ready.', 'warn', 6000);
    return 'stopped';
  },
  returnAfterRevive() {
    this.resumeAfterRevive = false;
    Hunt.deathAt = 0; Hunt.revived = false; Hunt.targetGid = 0;
    if (Town.autoRevive()) Town.begin(true);
    else if (Settings.profile.hunt.center) WalkBack.start(true);
    else Hunt.stop('No saved hunting spot for revival return.');
  },
  tick() {
    try {
      this.guard('Reconnect', () => Reconnect.tick());
      Restock.sample();
      Alchemy.tick();
      if (BuffGear.run) {
        if (World.inWorld()) { Party.tick(); Potion.tick(); }
        if (BuffGear.tick()) { this.mode = 'buff gear'; return; }
      }
      if (Alchemy.run || Alchemy.pending) { if (World.inWorld()) Party.tick(); this.mode = 'alchemy'; return; }
      if (World.inWorld() && World.isDead() && Hunt.running) {
        Town.cancel(); Resurrect.cancelTrip(); Resurrect.holdUntil = 0;
        Party.acceptResurrection();
        Hunt.tick(); this.mode = Hunt.state; return;
      }
      if (World.inWorld() && !World.isDead() && (this.resumeAfterRevive || Hunt.running && Hunt.deathAt)) {
        if (World.gp?.inventoryPending || !World.local()) { this.mode = 'waiting'; return; }
        if (!this.resumeAfterRevive && Hunt.cfg().center && dist2D(World.pose(), Hunt.cfg().center) <= Hunt.cfg().radius) {
          Hunt.deathAt = 0; Hunt.revived = false; Hunt.targetGid = 0;
        } else this.returnAfterRevive();
      }
      if (Town.trip) {
        if (World.inWorld()) Party.tick();
        // Reserve the first settled item-use window for departure. Continuing
        // alternating potions first can perpetually renew the 350 ms hold.
        if (Town.trip.phase !== 'recall' || !Town.trip.potionWindowReserved || World.isCasting() || World.gp?.inventoryPending) Potion.tick();
        Town.trip.potionWindowReserved = true;
        if (Town.tick()) { this.mode = 'town service'; return; }
      }
      if (!World.inWorld()) { this.mode = 'waiting'; return; }
      Party.tick();
      Party.resumeTick();
      AutoMastery.tick();
      Potion.tick();
      Loot.checkPetFull();
      if (Town.tick()) { this.mode = 'town service'; return; }
      if (BuffGear.tick()) { this.mode = 'buff gear'; return; }
      if (SpeedScroll.tick()) { this.mode = 'speed scroll'; return; }
      if (!WalkBack.active && !Restock.trip && !Restock.recording && !Controller.resumeAfterRevive &&
          !Restock.activeShop() && !World.gp.storage && Resurrect.tick()) {
        this.mode = 'resurrect'; return;
      }
      if (WalkBack.active) { this.mode = 'returning'; WalkBack.tick(); }
      else if (Restock.recording) this.mode = 'recording';
      else if (Hunt.running) { Hunt.tick(); this.mode = Restock.trip ? 'shopping' : Hunt.state; }
      else this.mode = 'idle';
    } catch (e) {
      stopAll();
      if (now() - this.lastErrorAt > 5000) { this.lastErrorAt = now(); Log.error(e.message || String(e)); UI.toast('Bot stopped: ' + e.message, 'warn'); }
      this.mode = 'error';
    } finally {
      Town.record();
      Stats.sample();
    }
  },
};


// Anti-stuck watchdog. While hunting it watches for confirmed progress (kills, XP, gold,
// pickups, damage dealt to the target). Without progress it first drops the current target,
// then walks back to the saved hunting spot, and finally stops instead of idling forever.
const AntiStuck = {
  idleMs: 0, lastAt: null, signature: '', damage: '', recoveries: 0, recoveringUntil: 0, message: '',
  cfg() { return Settings.profile.hunt.antiStuck; },
  // These states are working normally or deliberately waiting; they do not count as stuck.
  counts: new Set(['search', 'return', 'select', 'fight']),
  reset() { this.idleMs = 0; this.lastAt = null; this.signature = ''; this.damage = ''; this.recoveries = 0; this.recoveringUntil = 0; },
  sign() {
    const s = Stats.session;
    return [s.kills, s.xp, s.gold, s.items].join('|');
  },
  tick() {
    const c = this.cfg();
    if (!c.enabled || !Hunt.running || !World.inWorld()) { this.lastAt = null; return; }
    const t = now(), gap = this.lastAt === null ? 0 : t - this.lastAt;
    this.lastAt = t;
    // A gap means Hunt.tick did not run (town trip, shopping, walk-back): start counting afresh.
    const signature = this.sign(), damage = Hunt.targetGid ? String(World.hpOf(Hunt.targetGid)) : '';
    if (gap > 1500) { this.idleMs = 0; this.signature = signature; this.damage = damage; return; }
    // Hurting the current target keeps the timer fresh; only confirmed gains clear earlier recoveries.
    if (damage && damage !== this.damage && this.damage) this.idleMs = 0;
    this.damage = damage;
    if (signature !== this.signature) {
      this.signature = signature; this.idleMs = 0; this.recoveries = 0;
      return;
    }
    if (!this.counts.has(Hunt.state)) return;
    this.idleMs += gap;
    if (this.idleMs >= c.minutes * 60000) this.recover();
  },
  recover() {
    const c = this.cfg(), H = Hunt.cfg();
    this.idleMs = 0; this.recoveries++;
    if (this.recoveries > c.maxRecoveries) {
      this.message = 'No progress after ' + c.maxRecoveries + ' recoveries.';
      return Hunt.stop('stuck: no progress after ' + c.maxRecoveries + ' recoveries');
    }
    if (Hunt.targetGid) Hunt.ban.set(Hunt.targetGid, now() + 60000);
    Hunt.targetGid = 0; Hunt.selTries = 0; Loot.suspend();
    Log.warn('Anti-stuck recovery ' + this.recoveries + '/' + c.maxRecoveries + ' after ' + c.minutes + ' min without progress.');
    if (this.recoveries >= 2 && H.center) {
      // WalkBack stops and later restarts hunting; this window keeps the recovery count across both events.
      this.recoveringUntil = now() + 660000;
      WalkBack.start(true);
      if (!WalkBack.active) this.recoveringUntil = 0;
      this.message = 'Recovery ' + this.recoveries + ': walking back to the hunting spot.';
      UI.toast('Stuck: walking back to the hunting spot.', 'warn', 3500);
    } else {
      Cmd.move(World.pose());
      this.message = 'Recovery ' + this.recoveries + ': dropped the current target.';
      UI.toast('Stuck: dropped the current target.', 'warn', 3500);
    }
  },
  status() {
    const c = this.cfg();
    if (!c.enabled) return 'Anti-stuck is off.';
    return (this.message || 'Watching for progress.') + (Hunt.running ? ' No progress for ' + Math.floor(this.idleMs / 1000) + ' s.' : '');
  },
};
const huntTickBeforeAntiStuck = Hunt.tick;
Hunt.tick = function () {
  huntTickBeforeAntiStuck.apply(this, arguments);
  AntiStuck.tick();
};
bus.on('hunt', running => {
  if (now() < AntiStuck.recoveringUntil) { if (running) AntiStuck.recoveringUntil = 0; AntiStuck.lastAt = null; return; }
  AntiStuck.reset();
  if (!running) AntiStuck.message = '';
});


// Always-on reconnect. When the connection to the game is lost (a server restart, a network drop) the bot waits for the
// game's own retries, then re-enters the world with the login the page already holds, as the Enter button would.
// It never types or stores credentials: if the login itself is gone it says so and waits for you. Hunting that was
// running resumes once the character is back at the hunting spot. Choosing logout, disconnect, exit or restart yourself
// cancels everything, and so does logging in or entering a character by hand.
const Reconnect = {
  intent: null, attempts: 0, nextAt: 0, waitUntil: 0, backAt: 0, message: '',
  DELAYS: [4000, 10000, 20000, 30000], GIVE_UP_MS: 12 * 3600 * 1000,
  active() { return !!this.intent; },
  clear(message = '') { this.intent = null; this.attempts = 0; this.nextAt = this.waitUntil = this.backAt = 0; this.message = message; },
  // The connection was lost while the bot may have been working: remember what to restore.
  lost() {
    if (!World.charName) return;
    const busy = !!(Hunt.running || Town.trip || WalkBack.active);
    if (!this.intent) { this.intent = { character: World.charName, hunting: busy, since: now() }; this.attempts = 0; this.nextAt = now() + 2000; this.message = 'Connection lost; waiting for the game to reconnect.'; Log.warn('Connection lost; reconnecting automatically.'); }
    else if (busy) this.intent.hunting = true;
    this.backAt = 0;
  },
  // The player took over: never fight their choice.
  manual(kind) {
    if (this.intent && ['logout', 'disconnect', 'exit', 'restart', 'login', 'enter-world'].includes(kind)) this.clear('Automatic reconnect cancelled.');
  },
  send(command) {
    if (!Hook.post) return false;
    try { Hook.post({ kind: 'session', command }); return true; } catch (e) { Log.warn('Reconnect command failed: ' + (e?.message || e)); return false; }
  },
  tick() {
    const i = this.intent;
    if (!i) return;
    if (now() - i.since > this.GIVE_UP_MS) return this.clear('Gave up reconnecting after 12 hours.');
    if (World.inWorld()) return this.back(i);
    this.backAt = 0;
    const phase = World.phase, error = String(World.session?.error || '');
    if (['connecting', 'entering-world', 'reconnecting'].includes(phase)) { this.message = 'Reconnecting…'; return; }
    if (['signed-out', 'listing-servers', 'loading-roster', 'authenticating'].includes(phase) || /authentication required/i.test(error)) {
      this.message = 'The login is gone (server restart?). Log in and enter your character again; the bot resumes when you are back.';
      return;
    }
    if (now() < this.nextAt || now() < this.waitUntil) return;
    const n = this.attempts++;
    // First the game's own resume, then a fresh entry with the held login.
    const sent = this.send(n === 0 ? { kind: 'reconnect' } : { kind: 'enter-world', character: i.character });
    this.nextAt = now() + this.DELAYS[Math.min(n, this.DELAYS.length - 1)];
    this.waitUntil = now() + (sent ? 8000 : 0);
    this.message = 'Reconnecting (attempt ' + (n + 1) + ')…';
    if (sent && n === 0) UI.toast('Disconnected from the game; reconnecting automatically.', 'warn', 5000);
  },
  // Back in the world: resume only what was running, and only when that is safe.
  back(i) {
    if (World.charName !== i.character) return this.clear();
    if (!this.backAt) { this.backAt = now(); this.attempts = 0; this.message = 'Back in the game; settling.'; return; }
    if (now() - this.backAt < 3000 || !World.local() || World.gp?.inventoryPending) return;
    if (!i.hunting || Hunt.running || World.isDead()) {
      this.clear(i.hunting && World.isDead() ? 'Back in the game, but the character is dead; hunting was not resumed.' : 'Back in the game.');
      return UI.toast(this.message, 'info', 4000);
    }
    const outcome = Controller.resumeHunting('Back in the game');
    this.clear(outcome === 'stopped' ? 'Back in the game, but not at the hunting spot. Use Return & hunt when ready.' : '');
  },
};
bus.on('phase', phase => {
  if (['disconnected', 'failed', 'reconnecting'].includes(phase)) Reconnect.lost();
});
Hook.observers.push(command => Reconnect.manual(command?.kind));


// Spends skill points automatically, one confirmed training at a time: first the masteries you tick, then
// the next level of the skills in your rotations, buffs and imbue. It follows the game's own rules: a mastery
// cannot pass the character level or 120 (level 0 is free, otherwise the price is the table cost of its
// current level); a skill must be trainable, be the next level of its group, and meet its mastery,
// prerequisite, STR and INT requirements. A reserve keeps some skill points unspent.
const MASTERY_NAMES = { 257: 'Bicheon', 258: 'Heuksal', 259: 'Pacheon', 273: 'Cold', 274: 'Lightning', 275: 'Fire', 276: 'Force',
  513: 'Warrior', 514: 'Wizard', 515: 'Rogue', 516: 'Warlock', 517: 'Bard', 518: 'Cleric' };
const AutoMastery = {
  pending: null, blocked: new Map(), message: 'Auto mastery off.', lastAt: -Infinity, note: null, turn: 'masteries',
  cfg() { return Settings.profile.mastery; },
  active() { const c = this.cfg(); return !!(c.enabled || c.skills); },
  gap() { const g = Number(this.cfg().gap); return Number.isInteger(g) ? Math.max(0, Math.min(50, g)) : 0; },
  reserve() { const r = Number(this.cfg().reserve); return Number.isInteger(r) ? Math.max(0, r) : 0; },
  name(id) { return MASTERY_NAMES[id] || 'Mastery #' + id; },
  reset() { this.pending = null; this.blocked.clear(); this.turn = 'masteries'; this.message = this.active() ? 'Waiting for character data.' : 'Auto mastery off.'; },
  rows() { return (World.gp?.progression?.masteries || []).filter(m => m && Number.isInteger(m.id) && Number.isInteger(m.level)); },
  spare(progression) { return Number.isInteger(progression.skillPoints) ? progression.skillPoints - this.reserve() : -Infinity; },
  // Why a mastery cannot be raised right now, or '' when it can.
  reason(row, progression) {
    if (!Number.isInteger(progression.level)) return 'character level unknown';
    // The game stops a mastery at the character level (or 120); the gap keeps it that many levels below.
    const limit = Math.min(120, progression.level - this.gap());
    if (row.level >= limit) return this.gap() ? 'at your limit (' + limit + ', ' + this.gap() + ' below your level)' : 'at the character level limit';
    if (row.level === 0) return '';
    const cost = Stats.levels?.[row.level]?.masteryTrainSpCost;
    if (!Number.isInteger(cost)) return 'price unknown';
    return this.spare(progression) < cost ? 'needs ' + cost + ' skill points' + (this.reserve() ? ' beyond the ' + this.reserve() + ' reserve' : '') : '';
  },
  // Highest learned level in a skill group, 0 when none.
  groupLevel(group) { return Math.max(0, ...(World.groups.get(group) || []).filter(s => World.learned(s.id)).map(s => s.level ?? 0)); },
  // Skill groups the player already uses, in rotation order: attacks, buffs, imbue.
  wanted() {
    const m = Settings.profile.macro, groups = [], seen = new Set();
    const add = e => { const g = e?.group ?? e?.id; if (Number.isInteger(g) && !seen.has(g)) { seen.add(g); groups.push(g); } };
    for (const key of CLASS_KEYS) (m.rotations[key] || []).forEach(add);
    (m.buffs || []).forEach(add); add(m.imbue);
    return groups;
  },
  skillReason(row, progression) {
    if (!row.trainable) return 'cannot be trained';
    if (World.learned(row.id)) return 'already learned';
    if (row.level !== this.groupLevel(row.group) + 1) return 'train the preceding level first';
    if ((row.masteries || []).some(r => r.ID && !progression.masteries.some(m => m.id === r.ID && m.level >= r.Level))) return 'mastery level too low';
    if ((row.prerequisites || []).some(r => r.ID && this.groupLevel(r.ID) < r.Level)) return 'prerequisite skill missing';
    if ((row.reqStr ?? 0) > (progression.stats?.strength ?? 0)) return 'strength too low';
    if ((row.reqInt ?? 0) > (progression.stats?.intellect ?? 0)) return 'intelligence too low';
    const cost = Number.isInteger(row.spCost) ? row.spCost : Infinity;
    return this.spare(progression) < cost ? 'needs ' + cost + ' skill points' + (this.reserve() ? ' beyond the ' + this.reserve() + ' reserve' : '') : '';
  },
  send(kind, id, label, extra) {
    if (!Cmd.raw({ kind, id }, label)) return false;
    this.pending = { kind, id, at: now(), ...extra }; this.lastAt = now();
    this.message = label + '.';
    return true;
  },
  masteryStep(progression, skipped) {
    if (!this.cfg().enabled) return false;
    if (!Stats.levels) { Stats.loadLevels(); skipped.push('mastery prices loading'); return false; }
    for (const id of this.cfg().ids) {
      const row = this.rows().find(m => m.id === id);
      if (!row) continue;
      if ((this.blocked.get('m' + id) ?? 0) > now()) { skipped.push(this.name(id) + ': recently refused'); continue; }
      const why = this.reason(row, progression);
      if (why) { skipped.push(this.name(id) + ': ' + why); continue; }
      return this.send('mastery-train', id, 'Raising ' + this.name(id) + ' from ' + row.level, { level: row.level, name: this.name(id) });
    }
    return false;
  },
  skillStep(progression, skipped) {
    if (!this.cfg().skills) return false;
    if (!World.groups.size) { skipped.push('skill catalogue not loaded'); return false; }
    for (const group of this.wanted()) {
      const current = this.groupLevel(group);
      if (!current) continue;
      const row = (World.groups.get(group) || []).find(s => s.level === current + 1);
      if (!row) continue;
      const label = (World.skillName(World.bestOfGroup(group, row.id) || row.id) || 'Skill') + ' level ' + row.level;
      if ((this.blocked.get('s' + row.id) ?? 0) > now()) { skipped.push(label + ': recently refused'); continue; }
      const why = this.skillReason(row, progression);
      if (why) { skipped.push(label + ': ' + why); continue; }
      return this.send('skill-train', row.id, 'Learning ' + label, { name: label });
    }
    return false;
  },
  tick() {
    const c = this.cfg(), gp = World.gp;
    if (!this.active()) { this.pending = null; this.message = 'Auto mastery off.'; return; }
    const progression = gp?.progression;
    if (!World.inWorld() || World.isDead() || !progression || !Array.isArray(progression.masteries)) { this.message = 'Waiting for a living character.'; return; }
    const p = this.pending;
    if (p) {
      const mastery = p.kind === 'mastery-train', row = mastery ? this.rows().find(m => m.id === p.id) : null;
      if (mastery ? row && row.level > p.level : World.learned(p.id)) {
        this.pending = null; this.blocked.delete((mastery ? 'm' : 's') + p.id); this.turn = this.turn === 'masteries' ? 'skills' : 'masteries';
        UI.toast(mastery ? p.name + ' mastery raised to ' + row.level + '.' : p.name + ' learned.', 'info', 4000);
        this.message = mastery ? p.name + ' raised to ' + row.level + '.' : p.name + ' learned.';
      } else if (now() - p.at > 10000) {
        // The server may have refused (for example its total mastery limit). Never resend blindly.
        this.pending = null; this.blocked.set((mastery ? 'm' : 's') + p.id, now() + 60000);
        this.message = p.name + ' was not accepted; trying again in a minute. ' + (gp.trainingError || '');
      } else return;
    }
    if (gp.trainingPending || gp.trainingError) {
      this.message = gp.trainingError || 'Waiting for the previous training to finish.'; return;
    }
    if (now() - this.lastAt < 1500 || !Cmd.spaced('mastery-train') || !Cmd.spaced('skill-train')) return;
    const skipped = [], order = c.order === 'skills' ? ['skills', 'masteries'] : c.order === 'alternate' ? (this.turn === 'skills' ? ['skills', 'masteries'] : ['masteries', 'skills']) : ['masteries', 'skills'];
    for (const step of order) if (step === 'masteries' ? this.masteryStep(progression, skipped) : this.skillStep(progression, skipped)) return;
    this.message = c.enabled && !c.ids.length && !c.skills ? 'Choose which masteries to raise.'
      : 'Nothing to raise (' + (skipped.join('; ') || 'selected masteries not found') + ').';
  },
  status() { return this.message; },
  draw(parent) {
    const box = UI.group('Auto mastery and skills', UI.check('Raise selected masteries automatically', () => this.cfg().enabled, v => { this.cfg().enabled = v; this.pending = null; this.blocked.clear(); }));
    const rows = this.rows();
    if (!rows.length) box.append(el('p', 'Enter the game with a character to choose masteries.', 'muted'));
    for (const row of [...rows].sort((a, b) => a.id - b.id)) {
      box.append(UI.check(this.name(row.id) + ' (Lv ' + row.level + ')', () => this.cfg().ids.includes(row.id), v => {
        const ids = this.cfg().ids.filter(id => id !== row.id);
        if (v) ids.push(row.id);
        this.cfg().ids = ids;
      }));
    }
    box.append(UI.number('Keep this many levels below my level', () => this.cfg().gap, v => this.cfg().gap = v, 0, 50),
      UI.check('Upgrade my rotation and buff skills automatically', () => this.cfg().skills, v => { this.cfg().skills = v; this.pending = null; this.blocked.clear(); }),
      UI.number('Keep this many skill points unspent', () => this.cfg().reserve, v => this.cfg().reserve = v, 0, 100000000),
      UI.select('Spend skill points on', [['masteries', 'Masteries first'], ['skills', 'Skills first'], ['alternate', 'Alternate']], () => this.cfg().order, v => this.cfg().order = v));
    this.note = el('p', this.message, 'muted');
    box.append(this.note, el('p', 'Trains one level at a time and waits for each to be confirmed. Masteries are raised in the order you tick them until they reach your character level (or 120) minus the gap; level 0 is free, otherwise the price is the table cost of the current level. Skills are the next level of the attack, buff and imbue skills you already use, using the game\'s own requirements (mastery level, prerequisite skills, STR and INT, skill points). The reserve is never spent. Works while hunting is stopped and does nothing while you are dead. If the server refuses a level (for example its mastery total limit) the bot waits a minute before trying again. Off by default and saved per character.', 'muted'));
    parent.append(box);
  },
};
// Optional features run behind the controller's guard so a bug in one can never stop hunting.
for (const [name, owner, method] of [['Party', Party, 'tick'], ['Party resurrection', Party, 'acceptResurrection'], ['Party resume', Party, 'resumeTick'], ['Auto mastery', AutoMastery, 'tick'], ['SoX alerts', Stats, 'soxFound']]) {
  const original = owner[method];
  owner[method] = function (...args) { return Controller.guard(name, () => original.apply(this, args)); };
}


// Automatic HP recovery kits for your attack and pickup pets. Kits are companion items (type 3/3/1/4): the game
// needs the pet named in the item-use command, so this sends it explicitly. Player potions always go first, kits
// are never resent until the previous one is seen to be consumed, and a pet that cannot be healed is left alone
// for 30 seconds instead of burning kits.
const PetPotion = {
  maxHp: null, loading: null, retryAt: 0, pending: null, blocked: new Map(), lastAt: -Infinity, message: 'Pet potions off.',
  cfg() { return Settings.profile.potion.petHp; },
  reset() { this.pending = null; this.blocked.clear(); this.lastAt = -Infinity; this.message = this.cfg().on ? 'Waiting for a pet.' : 'Pet potions off.'; },
  kits() { return World.items().filter(i => Number.isInteger(i.typeFlags) && ItemType.potionCategory(i.typeFlags) === 4 && (i.quantity ?? 1) > 0); },
  total(ref) { return this.kits().filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  heal(item) { return Number(item.tooltip?.fields?.itemParam1_29c) || 0; },
  // The catalogue gives each pet's maximum HP; the live vitals row is preferred when the game publishes one.
  async load() {
    if (this.maxHp || this.loading || now() < this.retryAt || !W.location?.origin) return;
    this.retryAt = now() + 30000;
    this.loading = Icons.request('/assets/data/cosPresentation.json', 'json').then(data => {
      const rows = data?.rows;
      if (!rows || typeof rows !== 'object') throw Error('Invalid pet catalogue');
      this.maxHp = new Map(Object.entries(rows).filter(([, row]) => Array.isArray(row) && Number.isInteger(row[1]) && row[1] > 0).map(([id, row]) => [Number(id), row[1]]));
    }).catch(() => {}).finally(() => { this.loading = null; });
    return this.loading;
  },
  // Living attack (band 3) and pickup (band 4) pets with their HP as a percentage; unknown maximums are skipped.
  pets() {
    const out = [];
    for (const rec of World.gp?.cosRecords || []) {
      if (!rec || rec.dead || !(rec.hp > 0) || (rec.band !== 3 && rec.band !== 4) || !Number.isInteger(rec.gid) || rec.gid <= 0) continue;
      const vital = World.vitalsOf(rec.gid), max = vital?.maxHp > 0 ? vital.maxHp : this.maxHp?.get(rec.refObjId);
      if (!(max > 0)) continue;
      const hp = vital?.maxHp > 0 && Number.isFinite(vital.hp) ? vital.hp : rec.hp;
      out.push({ gid: rec.gid, hp, max, pct: hp / max * 100 });
    }
    return out;
  },
  // Smallest kit that covers the missing HP, otherwise the biggest one.
  pick(missing) {
    const kits = this.kits().sort((a, b) => this.heal(a) - this.heal(b));
    return kits.find(k => this.heal(k) >= missing) || kits[kits.length - 1] || null;
  },
  tick() {
    const c = this.cfg(), P = Settings.profile.potion;
    if (!c.on || !P.enabled) { this.pending = null; this.message = 'Pet potions off.'; return false; }
    if (!World.inWorld() || World.isDead()) return false;
    this.load();
    const p = this.pending;
    if (p) {
      if (this.total(p.ref) < p.before) this.pending = null;
      else if (now() - p.at > 5000) { this.pending = null; this.blocked.set(p.gid, now() + 30000); this.message = 'The pet did not take the recovery kit; waiting 30 s.'; }
      else return false;
    }
    if (World.gp.inventoryPending || now() - this.lastAt < 1500 || now() - Potion.lastUse < P.delayMs) return false;
    const known = this.pets(), pets = known.filter(x => (this.blocked.get(x.gid) ?? 0) <= now()).sort((a, b) => a.pct - b.pct);
    if (known.length && !pets.length) return false;
    if (!pets.length) { this.message = World.gp?.cosRecords?.some(r => r && !r.dead && r.hp > 0 && (r.band === 3 || r.band === 4)) ? 'Waiting for pet HP data.' : 'No attack or pickup pet to heal.'; return false; }
    const pet = pets[0];
    if (pet.pct > c.pct) { this.message = 'Pet HP ' + Math.round(pet.pct) + '%; heals at ' + c.pct + '%.'; return false; }
    const kit = this.pick(pet.max - pet.hp);
    if (!kit) { this.message = 'Pet HP low but no pet recovery kits in the bag.'; return false; }
    if (!Cmd.itemUseOnPet(kit.slot, pet.gid)) return false;
    this.pending = { ref: kit.refObjId, before: this.total(kit.refObjId), gid: pet.gid, at: now() }; this.lastAt = now();
    this.message = 'Used a recovery kit on the pet at ' + Math.round(pet.pct) + '% HP.';
    return true;
  },
};
// The game requires the pet in the command; the compact command layer only sends untargeted item uses.
Cmd.itemUseOnPet = function (slot, gid) {
  const gp = World.gp, item = gp?.inventory?.find(i => i.slot === slot);
  if (!item || gp.inventoryPending || World.isDead() || !this.spaced('item-use') || ItemType.useTarget((item.typeFlags ?? 0) >>> 0) !== 'companion') return false;
  if (!gp.cosRecords?.some(r => r && r.gid === gid && !r.dead && r.hp > 0)) return false;
  return this.raw({ kind: 'item-use', slot, companionGid: gid }, 'Use on pet: ' + (item.name || item.refObjId));
};
// Player potions keep their priority: the pet kit is only considered when none was used this tick.
const playerPotionTick = Potion.tick;
Potion.tick = function () {
  const before = this.lastUse;
  playerPotionTick.apply(this, arguments);
  if (this.lastUse === before) Controller.guard('Pet potions', () => PetPotion.tick());
};


const LEAN_SKIN = {"f_lu":"data:image/png;base64,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","f_mu":"data:image/png;base64,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","f_ru":"data:image/png;base64,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","f_ls":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAACACAYAAAB5sSvuAAAD6ElEQVR4nO1bS44UMQx9jGrhknpRIw0S1+AwnIA9K67DBglxFI4BexbTi5HKi5JAduzE9QGJNc+oJ01XJXm2n5MoiV8tT8uvjx8+4tPnL3j/7i0+ff2G7z++YycTIPFVASwiwCTAhvbAyg3QTSGTtFJkfJ+A+4tiuYmX9ru3OVkd+Lsu1k7IbD9NMx4SwLKcXzrJJFhuizfa4arVsT/RkXfc2kqgVs9KVUBuqWqRrYJq5Qpg1TUAhgUS7JU4hK1ZIgHALKTqz9IIDax2a95f7vu23dLRppVuRfV2DJTJWvA4wHVdO7Bu7oOGguYu71zHB9KeHS2dYnS4q4Fsrm59jFdTWe/XwFubRRzgPM/FKn+woIFzLjY3VovAQB/AJc/MSkYLkUYNBxmfAXjQy+sFnztA58dL+8E1qCDL965EsaxLdJCNdokAsDbNiq1+UaCYcrZ+goPulbCoA7QGJIJkfUkm7MU7Mq5g8GanXNDAJJ95me8FRexfRncLsPZx3qV7k4MSAL3DsODj0yMurRRldYtE1FaXe3Bg8KkHQpKgDEe9bq8fChrQAPmQRN6NRRdDzcl9/q6OAIpGe8cX3OoBEQr458j5bCPEAd4zIhuUM5DUMqMsB2aEGGdu4TZ/r/C5tLFzvdcON1eQycNofYyD00UgZMVi1fpcMPhnpc8Mxa2dt6FUBdy47GOUP5uned+viAdOj+IkuFnzKCfQMVzcLbgk+OtWHu2kUulaD8SYReRC8XVbx/8D8JoDileMdq+iOAneORXFktPWtHdlRmy+7/VjPk/n7vh3nGmK69swc9cRxbdi6urWcN8g9+Cc5ID9L+Nn8qxGcSifg3UHaF8eX7fh5fnKguaenPCzw5xPVctiIBSId7oFVcciYzdCjFkjvTRjbi6W5uaO/fnnM4A3mIsF+5CRBHeO5QBcNdeYxoqlInB6sISS6e5Wf3hk1G3rAh+4sYahbSoKF1cNK5BG7KbnktPUNtaDCfxv60G5DW+kcsf1YAPG9aByPXgSrgcnrgfB9SAiHM4RwvUguB5EpQPXg0fhenDjelCdCtwfNOH+4MT9QXB/ULk/uHF/cC/cH9zCEtwfVO4PgvuDwvNi8LwYPC9Wnhdvh9UCz4tRlk48L5ZmCZ4Xm/C8WHheDJ4XI4OB9weV9wfB+4PK+4Pg/UHw/iB4fxC8PwjeH9x4f/AszCcR5pOA+SQwYT4JmE8ifWwU5pOA+SQuzCcB80mkcYH5JCbML55wKcwnmZhPAuaTIMLhHCHMJwHzSVDpwHySozCfZGM+iToVmE9iwnySifkkYD6JMp9kYz7JXphPsoUlmE+i/2E+yW+Nttse6TuuYgAAAABJRU5ErkJggg==","f_rs":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAACACAYAAAB5sSvuAAADIElEQVR4nO1ZS44TMRQsWkayJRYTiQtwEE7AeVjNmVizmw0H4AhskFhmg2RLWGL0bD/3c6edpAnLKmkm7fhXfr+2Km+e3j/9PfkTYopISBB4oD1hbee1nXICpJ0BuPZn+u04D3+57s5YWeP58zNevr3g08cP+PL1O378/IVFyOmACzLbhTopvw5283GVUD1MIarzr+AUKh/l4GKOg1XKCTeb2u90wwtizrTbYSst0zexdN9HODSPNBNg0QneefiJu3RwmSjW27NE3pA9irZmSja4hKC37E965nUTmWQIlXGzDRRqrd5eY/AqedOnuzh5CjIze6R0vhg4bKjJcdWtDYOFa6J0TxyAqwsHicbiPrGWuLqYWlyqcdk2Kq1b8ZRNPO30TWGTsz0v8i+K5XosmljbJIg51v6zRQn00WaT4BgQ/8Rh9FJP6ocMUgttNxB4/cocoqMfItW+XrrauBslRhDehqG9aODKgmHjIi2wQ5zpc2olx6Lz3RBSondkd4zNgu3wSwngFm9RPrXWCZIumi4zWslms/rmIDUxViuXuddIZiCEMGT+Ihlc3ibFvdXVhVQvK5XeYK17YhAmjm1puuZm8eQ7LXP108UyISI44NyK5PDmaO/TgdCeBd0kkW68PbZIv9V7zYI6WYj2wNaqvjldte4k4PMOOdt3gKRdY9GH6oaEk6SpCeotoX96kxyA72WiJYkkSHChXYuqm4tLteQIyXZrkcm2fMC6d8dq/VrWa+v1ujmGg7p4d8I9JfX/wzuPczwPluR90IsZeB/MvA9OwfugBe+D4H0QvA+u4H0QvA+O4H3QgvpgHuxBfbCD+qCC+mCmPjgF9UEL6oPJmoP6YAX1wUdAfRD8vdjx9+LDoD5oQX0Q1AdBfXAF9UFQHxxBfdCC+mAe7EF9sIP6oIL6YKY+OAX1QQvqg8mag/pgBfXBR0B9ENQHHfXBw6A+aEF9ENQHQX1wBfVBUB8cQX3QgvpgHuxBfbCD+qCC+mCmPjgF9UEL6oPJmoP6YAX1wUdAfRDUBx31wcOgPmhBfRDUB0F9cAX1QVAfxICJPvgKdjFbx2lo7k0AAAAASUVORK5CYII=","f_ld":"data:image/png;base64,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","f_md":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAAAwCAYAAADZ9HK+AAADsUlEQVR4nO1cQaobMQx9E6bgQBcT+Itsu2uv02t8eoTeoPfq7l+jiy5+F4EYGkiRLNmyJ/nQrKqO9CmTGfvJ5fGQZdkz0/F4vEJtBnCR33SdgXzJSHPiR/SbLCGVvqMFHt7423HHS0bOuYDUgQ4g9+xI/tiR9g08PPO3Y5UY9WS6ow5yn1Lie1aRUR31476Bh2f+pmVZrtRAHVQlGjo4XMwJ+xk4k3N1xKrioWqoCXxyyd+kOQCHEKsaO5/IQOwgpdZXBgg83PI3HZ+OHAH4H0lCgeRX5xR+RqA2f/AgRoGBh0v+SgTQTsZs9thURCPQs4xMTnReCTy88rfjBnViskieS1RhaqogHVgHDTy88lcEIE4krTCAXlG1X15nlYGHS/5W5YS6RiQV5RZiWFFWTWTjfeDhjb8WAcR03qiZpK4ZVUF2vrnxHwh8csVfXQZahxpK2pqxB1E7V5QwJBqBd8dfjQAlOSjwUjBsz1U9tpasTgLvmz/ZCxBlcIGgLBPYFGDXnKoum2UGHl7565NAs3tUNxdq6FAVNSfsyIagwMMbfztNEJJmi3beSK3GXAoIps+QYAQeLvmrm0EkCooU3UrSZJldDXnYcw483PJXBGCqQ0VBpVS4KjGOVYPqKPBwyp+UgiU8kHzugXXAi/aTpCPw8MxfWQUYhZQk4Q2wttVdpsB75o9PBN2qKGnW2M0zQzGhcxZ4l/ytSsFq9bSJXjtlDZsOgXfL3/3NILPMSKwYlCtvLLwxcODhib+yChiBt0KKOCwVpLbx2B05Djy88TellK63konO2a12tXvtgYcH/koOIMuCoigJERY8TjmjwgIPr/y1I2EaTrh0aED0204ab4WXwMMbf1OaZQoYHY4hQ8vJlzunTgPvkr9dFx/s2tGCxahyVPeda5/Ae+ZvLmVD2UIcokV1xp3bWyfWAg/X/JlCUB5eHOzVRAPZ0yVrC3xyyF/VgxwX6MuM5v2ydcloHD7wcMhfiwC2XDg6t6oRJa0s8PDI3wSgnQr+GzMbC4H3y9/jAgj7L+zubmDYNiwEsHELAWzcQgAbtxDAxi0EsHELAWzc5od6PlJ8CPw/yd/8/OW5PZRtwvo2qXxMyLaXDw/qS4jmHHrg4ZG/+eX7S/3QQP2y1AzsCfRuj/PvM/KpfF9uvwd+/PyFZVmaivSDA4GHR/6mb18/Ryl4wzZ9+vjhmk/A6+kVh/cHvpI6DsdD/fDgOZ+58+HpUA8c6mtprL/Awyt/0/JU3gsIwybtD2VlHuGFT6RIAAAAAElFTkSuQmCC","f_rd":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAwCAYAAABjezibAAAFuklEQVR4nM1Zv2scRxT+dIxgF04wCwr4ChfX2eAm+VNiksZ/RXAV/C84LoJIYSy7itKpMShdUgSUMikCagIqVKzAgl3QwQ5oweG9eW/27d5Z0p3O0X2HtHtzOzNv3o/vvZnd8t5/BMEBaPmOryEEbsvGGcIsIMuy1MbPmedDG5C5rHdPV/rdtt+E5989x9H7Izz75kvsvfuN+4wymmgIEizL4kSzOLAKmRZBbYGECPBjn9q5D7d3wgM3C5eUNMAoDhq1wVf5Y2Ey08kBNQnpRCutPONEoGsQzKJuLaRcHQ1NE9JcrCUXBwy0ahKCpEwrCzKZMaOC+qvmrLssgxbw4+gSeZbzeKzBnglZbXEy+pAP0oRDH1rkUxn37/xuWdCYSdsy/IgGq2d1EpIfClFY+sRO8rTVjAmWIAHB/YzJF/r3dQLK/AS/Gxc54iCw5hDfYsFkGUkjIhBPHES4mRFKzS+aZG0sIaQNNvJ3FlCpJErSH1CDQTXag3YZZ51pJWgYOs4SvthzG+k3YuGU99T3EnWIBoUDu78BZ7Z9nrQ0szSUrmTRo1BHE6mgfE++x0HS78gaHQRMUKGlTU3OUHdYBm4gIP2rQ93xmn1IfKuu644f6cOmj4JBOdTMwUuT9mU40O96w6nWB2EmFG1FAYWXlLiFH60GMxE4DP1uBROzr0s8qBVGyne6UvYnyr9sNske6l8wZjbaCtQnLnN1qNVklFrmi7nYUAtdz8/P+cqmFY1whlFhJLph0lKPZFeBal3TrYwVDTw20jvgwa4niYHa+KXJ2RowQXmSguq2BcE1oLmKostkLCBr5aLjOdZkfALee9YiO28txL0o1zpzXVWLDshzAFcx4NgXZ4DzJJCUVeqgveqEqpiLOgZL2xUOGiiZpZ07mriqAhr1dVGY05TSI1i5Z4HlZ+tfiV6wZCl1A5jSRMDyvOTriEsrIds4oaxAiVsLVy4I+kGS4W7VSw9Ead7HDEbllsu7KGYhhrnWZI4uEIR8hYiDZo9blPM3QiyX70TB1N2cpYthUUAZJkWopZU1mtWit1Ww1Qw3CAf2YCpr/b6wfHJYC9iamklElJjqqEAYlklyb82chFwXtQxAAaua07KNiwWtiG0OTdtHUfvcAqxW1wHO+z6NX55XfB3NaYRgnF/LJQ2MtIlak1ktaL7msuH7iY/BEqexuzimFNNJb9JC1kDKi9ACxU6BnNLJdjdvNDHtI0QzKYt8QkPrJOYhmobM2nC6U6QgIXDJxPuKGzT0uWimJVnyQUUte4pY48mW826V3UogJRVF0XGyRHMkag0IbqH/a8gMSyIF5IAtnGovPiRB8Bn97DpUl01XuauJU3VMsEdr/zec0FvbzBesjMHpwn0gzwtUl1rfYUDU940WC0u3dLq1CWiaaq7c2hwBnQRp72R2kwRE37xp445Ng0MvircAxFP++4QDfn77BhVtbeUI5vjPY/67D8abw96Pe9h/dwBcNVQqIN/OUZ6d8m9uI4R7ux+/SIDkX+T9ivq+8Ob1Ho7eH8bCoAXKixKn/57KFgRm0/SpCvm631aFi5eXr17i4JdDVFXD+2HaqB//vo/9V886yqHHX3z/Avk2kWQ3BlW1DTcE5HnGRxJ6JMeVb1GguWr43CbtBPWETLau9pWYfYa+U+VMRyneZyg/lKguKhz/sY+Dn37gx8qzqiu3Tv75K50BlmdlqslIQHLW6rLCpChQVRVy+k1P+mmgD1U8z/bxNCCd/JuqnBcj+4xih8aL90+/fYq67mrPo19P4adfx+f+PkxHf+6rRzI44Qnda/EQ2xu50sGRMr3uX6YPCgSKu7lCw+bTBkhTNJjQvZ5J0huCJsM0m3CgqAUmDyep99bjR48/poOidv5tpT3U5gN3Pks0r8GCvBGVfvxKzZzUx5c7FAAVinFXMU8fTnFychKFlPn0RRChmlX8fcvvyuvYDcV/DNlHo30tBwcAAAAASUVORK5CYII=","ib_lu":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAYCAYAAAD6S912AAACXElEQVR4nJVVMY4bMQycGCq4gIs1cA/IPSP3+MsznM4prkhxwG5hwCwWSDBDUpKTKgKMXWml4XCGor+8fn39/fAHNA7g8nIBGuC7Y31Zse87rBnsbHB3bdv2Dct50fu6rtrL4YejmRmMAEdgFvDt4wZ84L9HY1RGNwIeEen64ypWZFoBYPmseUMQccDhIDEBiiHfDNg/ySzAFISgcO7qDJYGSKAEt3NRAyjCKWGx7640FSCjLbboG0H4I8hDmZCZR0ZtsOa3xgUKf/sZYBS5xuMIs7Z7HCRjCq8MMqiGUncw1xMzegLLVHhQTAiQh8tljdLT8z33NmpVGwqEI/QD7LC+TuAAnXRtw0xN98+9Twqk6zKP1LCzTRCjm2XeQVMmKZxaKYecOwsiWfeSSSDqCMvv1C/jDrxIQwX+j/AEKfbW63AEt4lhTzNqT25a6eZ6KkjKUKkGqD1dAJ47lXM6KOvHoefrGOBKs+qvjJQ8wTgKeyoFgkjoYpVPJZ11OEzzUeS5dupiT6MOhYPxLAPiqsZ6z+CoYNJwLD490+VKsW5Ilyhbls3aCrB8KnHnAOlkB1FZTcaUFFUNDdNNmQtbzgyxdWByWm2r9EW0r371qpTYnS/rJUpHmjy7PAvfO/g9NO3f2G22uvBtwdu3N2z3LYCpV6b4iA4Y7WyqiErTyn1OLwb8kj4b3r+/Y10N16mp9OhcY3P17I0ESpZinX101GHpMYFVm5/nC/VNqQWWDMusNt9mfSgHU5usOrj91QsnoH4B1LFLCxMG9ntuoODTgSrmcYOinNb+9xqF/wfe42YwhNh78gAAAABJRU5ErkJggg==","ib_mu":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAcCAYAAADRJblSAAADF0lEQVR4nOWYTW7jMAyFaUEDKEAXWmThI0wLDNDe/w6dq2RRoAbGQAZ8ImlaTVdDrkZtYseWPjkv/JOWt9e3+7ZvxK3hnWjb6dRaPc5xjz/v4/rmjny91UaRPErmL0R0p/+4FVb0UWutDeVEUd+Pz+0z93H3o3nZ/MoDYVbbMCu0XYCbA/OgveEebG8/XoBxn+2YLIpnXzqJv6zXdcQA8QkGWwf1H1XOTahHjHV9e+sUyZuP0fyFBQBo30ZQkSCjwaaRHFlZBJVxvn3INQCPMfZgYbxc/rJe+x3GJKaxsV141Z1/zWZnZtrErNAfhDAe+iTyF1iAYtVU2H9EyUdNTc5PoA/D4yJ59qWS+AWqSIC0SMnK82SzqtJ4IsDmaMugYF42vyrAoiU9KCJYvY9hiiK/mRx+CfFJ/SUied7nM/hFFUJ1xCopnJs+gK+m9FdwpjT7YCQvm18A4X9WyZWUGKjKVWdSzvyGz43oij+OtsG8bH7BzTZVSFpRtbMvQX1OJ1KIIPCQMy19mEBeNr/AlJz5WL6Fr8jAqQy1aOurNZE6mpfNLzh1fqFqDaXOacUirXu1J5nEUkwsL5u/9N7v5ltTGrHU4aorVdjysA9AZqKBvGT+sq6jELKmKUT9a4qwvvJiLW/iY4cfTrnpH3mnWj+BXy7tclop+c6HIUlAsvpb+zXqvZ8eLpqXza/rup4VdcqiTTlY711+EH3+IboQ0ed3/QJ42fz68uvlS+dj4fBJVC9H9HQbDtDcT6Qmq0vVIF42v77/fjcWkolWWxp1peRUX0RgmfbkkH6w3NQkHchL5i/PP5/vpuCUW3Vz0TYdJ2W/bdG8RH7x0iCaElF/6gbSygk5dn+QU/Wzb5G8ZH4xRWVfjU3ndrudzUpKzNMKjV+6GPEPG81L5hc919SBHVX1M5iQKinF4xSFUX+Lr7lyPYyXzS/qN7aj4pQbBYMrQqSMHPfE5OShEHQAj+Vl8+u4KGpi09DtwWt5CRWP9ZhFXzVJ8as5Iofwai6/cOf12r8WGCqM7Z7IZGPNOVRV0/MpKJqXzP8L+GIR9aQjezsAAAAASUVORK5CYII=","ib_ru":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAYCAYAAAD6S912AAACl0lEQVR4nJ1VsYrbQBAdmy1GoEKGK+wicAYX54NArkhjyJcH7jeuSRk4FQarMOwWAof3Zma1CqmiO2O0O/vmzZu3483xdHyoqGivMk2TaFIZnlTG35NkEZGSpes7ud2zaMKCiMwih/1BCv7uRVSVy/jeiMhD/uM5v5wrSCmFH0kiG1U1QGSfLRhMyuxrBf+lMmtBjqcj18jQYzf7/f7RJZE8C4PqZgBgfS6UAuuUBYD3iUnPpzPl4t44yRbnAiyeTjt+EAQw7I3TtACT1cD9j18fInOR6WqJyJAgYAktEIxDqGA2XcjcgSp7f4rr9/btjXtbBkTJ0KfXCgQt2fV+cPGWZKGl9kqwy48L95KhRDN0ZQNs4L3VlA1aNVDJ8DbdqC8ZtvohAOUHc7JwpvWZ1+VqjzMdv7dtlmhChlXwHpp551cOcKtpUxW6nAiCsjyzedACwk4stakiSrZGFRmGwc4M0DCMSUCzcDAhmPxldtbaNK8sPkXMtjWvcNEDwzahVQMcuu+gL5LPXuUMwNAiWh0JGhnWjVjezWql2my6F9OwHgp9mm5WbhEX++nfiRN0c1lM6NoclZJMo1XSJjmSqd+gPGfGJVoigFqdaGsDXYzuujY+VLccZiZu1Laq7drVYB8KtSleyWKXxQ1Dbx1A+enwfFjNuerLRj9OdJxIKuM4EsCGiHDNLoVVkS7fLyuLtBpxzjXl4Xn9+rquSEy/z+uNMen953tlMuD6RNfwPuBa+fCIQetq36CbV3X4cpDj89Gb4tl4ONi5Lz+vhddPizJpvmeR3uJh6uh0zpksc8myjdazIidHFrQKf/fMHqKye9otNkKi3hq024GrTfl6U6gHBqgPTTywQjUw/uI3pw6MRccOZ3uVP0Fqj0Adzr5HAAAAAElFTkSuQmCC","ib_ls":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAABACAYAAAAallfsAAACV0lEQVR4nO1XOW4jMRAsDxi0AAVUZv9g/f/HeJ/gYIFhMIA6GGAX1QdJyY42NQkJnOHRR1U3e/jy/uv978fvD9Ra8fb6hrmpKkTkYQwF0EMh1xg/fSyfN276MhGNm/R8Enp2bYACUqaxEyj3fCmcFCjUel/EHS7UFNA69lQwGSChUEWx3erQbtZQGLcV/sOCcMIEUNBpemIPwotwORdTkFlIa87wKP5yHZg6FC7I16n1rfncluBSUE5yMcfNFbqpaVUFQqG7r91986QApf1pg4TAq2P0zG7MJY81FaYRIiiYCOyMP79PBJirYU26LSLmUWsN21OU+aZDg6BgMAS4F4PlZJ+tHc2EbjBWI2yCOuuVQhP0EYtOVOCdMDHQOdcUpbsVC791na4dLpgmVrp3DJbVLHVPtoeNOZn4sM2ZwrAy60JYMF7rYHr7wmbmcEnsHjGs12qC9rbbs9TBOq3fOntTTOU7scnDwHASBnAzeC7l4ta21mPQMyWFT+S4q6O/hwXMBq7bj324I4xdQ9AEl34MpbAjF/LnmF2uI974frvewgg4rsyyUF7mXDZ2M94i4m0TBWMijPCEMm/OMue3PQYZmGnFnGqcHceXHyCdYVocFuW+chPgcxrwbrI2Uy3i9K53IySDX6jENnlmjThMdhMC5if/SVZYfREXZpZFVJB5DezLd6mXzUOFaAkQZyIfH2pKmU7sVVOwagpWTcGqKVg1BT+0pmxe88d3YP9UowIT7jW4f1FMdTm1y/QB+gMxLKsuY931Rlt3PV13PWvrrod118P/1JR/Y/YZdYKbZSwAAAAASUVORK5CYII=","ib_rs":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAABACAYAAAAallfsAAACqUlEQVR4nO1XsYrcMBB9WVzI4EKCC+yW+YPc/X+dJpBfSLlXHFjFgqYwJLynGdl3pEp71mLWlqyZN2/eaPCX5+/PfwDANgM2IE1ANUNOCbYBmLgK2MO0hinpnvNpSTAzXJ+ueHl+wa+fPzBxIqWExBf5M+jZuh1Y7Zt5yQEdJ1+Ev2uGta54rRUTX6yPqgUNeuY9N9Pssu/mRhl35HoGcLtmzGlGXjIunFB4Colhmu7pJEJWBLwyI3Ea5BDaszoF97c7LpwgZ3phc6NBg6OjEzl4dEpiEAjH7WvR/rIUTDLChdQ54mYaouFAwRHohY405u7YzLl15JdOdOeD4ci4wzBy6xkeKgjnpChnOW+toVnTHnEoQ8qyGwdQa+1GA2UkgnxtQNuaHJs7mqdZirgMOcSgcXcSFITTWJcBzFpvtSOTAyF0MY/hCPlyIP8X0oam9TnPmiZCzk8SprLbDXEyR/iuvch2PEeIv19XkFIqgCMvySvlQ9gWovW5EHAIXiAehuLoKGgViFmv1HrYQCxDlwcaopLao3P1LlGbx7N56YdUpKsDV/kpjyyOUB1VLwT0tcmwvq1KzCVKTUkYNbx7jnBDuGGEm/lD6o5LLsr8ZYRE4j/IR5qzHd0Il0iXuWd265VDYfOSbMLzEU3IJc5DjvJUut58TiWaEubi0lmIMMotThWdKL1OwyBD6k5Nx9QoUTe63lcZ470QHrkKGR0zeX+997UQvgUdphItt37a8BLCnPMuGxc178XLo4nsI1fhaGXZkdt1p2GSKEOsji56CjP3rqfwoJnK6CnlWsYpTiB7pXy+noKp9w8b/bj/D2TsKTxwhZBlegh32yn7dr19Wg7r2Zft7Mvp7MsaZ1/mOPtyOvtyPXuKnd967fzWw/mtt53feun/vvX+AoxewymeMkUNAAAAAElFTkSuQmCC","ib_ld":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAYCAYAAAD6S912AAACl0lEQVR4nF1Vy2rkMBDsMTr0gA8S7CEDe1hDLvmFwP7/TyzkuHsIWAeDGlYwofoh2XGYGdtSt6qqqzu37XV7fvz5oJwzlVyImfWDS0T0lzoRJf/gnq737DG1Vlos1BcSkXShelRNhmdNHsk02N912xsXYnhlSpQ8JYLXDFgWLEJCCBT9YA2HGGj82j5mJjnwUqiK0DJoyTeKp0uABkGeJGdWNJzYDsGhANaJlkvgWLQkllyGpggaKINyh1T2HtdyQQMKllk3mXZXDTOod6G97sTkB4Ce71lioyqGk3CyPytNoD3sHkBRSWy4p7slYYtHLP4G5cx5LujitEZzaWu1Q/djH6TYKx4ME8QNhIE29MIKKN1XS6wVFaGyFmMADQ+4w21EQovyU+RWflucydWLzmsUTA1lb1kRmo5Av+xeHRhTg1Q3t4RunAYOOUaFgdgRRYGWEqK6NcIh2inhSdcS71DdsEq4QfzQvJ6KEsKGtyO7Bp5sdee7aYk0UZA4QH14CjA6TgFahtFPKG3Nzey2wmCJZliiyko1hkGPNjOErbdpfC0WK70xJGTSSlLtAd/YjAY3u0R3CD1yma04WtTWJdrPLZWiSpFUafl8E58y9dMcENSbNNVSE63uV5cpjcZ3cUGl6jiyYCQbAxQz79QZemgVknQuyrdRNTwoZ+9ZYgwGhGF8GU26DGAwmvPQzWqIXHwg/oEAppef6HXTTnXWwUpmn060g1VH3uhf9tHENu/0mEPon/8r+PtJVLxnMUjU5MduWhKmTwwH5/54eVApRe/b/3axAk57OBLd71XY8jZ6OIDdtl/bE/Dff79PA7tl4rAYV4FmjrU25mJoeXt7fXvGBs48qjrb0XQD7X2AbjbCTiyauqTRF/QblaZaaQeLAAAAAElFTkSuQmCC","ib_md":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAMCAYAAADS87vJAAABvklEQVR4nM1WQWrDMBCcGBXW4IJzDPTQQC/Jqfn/oyKoQXsIpMxKa8kuveQkgWOPvJ5xVrMrHy5flycAKBQSBHgA+ijXwjuwOR4iQIwK4UVAHaHG+OiWL2zxQMB4EpJ4DShBuihUKa+IqibKaxMsIhoLnvJzXfPt8GBBTs6b5bzJHsgrm7NJlhWSyVdD0DvfHgcmDYE/nNGt7Wg1yeLrCzCmEV5jmdXJbdYx3w4P/rBlutSI1VAhWm3XkjKGq8Ls+YoIcI939M63x4fzx/lJYE1lN0hAMYqbnexhsdrJzvHAxpqM65jP7N/gwSZcyM41s5Zp67oladNspMTWePzwWBfomG+Pw7qlmJUEInMV9NJrXyCzVMKmDud5Rlxi/3wNDp5F7jUUsgCyMpNUWHLN5XrCmmH5swfnmN75fM5xmKcZ4zgipYTxfTTLjW8Zc3DOH+AqmN12HZYj/aTK0wOfOyJs+XzOcbhers1eWuvJO6nbyId313VlckTuyZqAMFZRTRiJX+XzFXzh/fBIYIqOcvyXDwAOt+/bU5eYbUP78GNqyjVi9Ky7gPyVpflPnT5PxVq5Lp1QY7RG1Dtfi38B9QuURhWwnEMAAAAASUVORK5CYII=","ib_rd":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAYCAYAAAD6S912AAACt0lEQVR4nF1VwWodMQycLD7I8ApeSOH10EOghybHQL+85JpLPyY5BNaQBfvwIGVG8j4nhs0DWxqNpJFyc//7/gMJ6HtHKQW1VpgZ+qXDAMAMlgy4dPQLdI8LHwD6WTLZP/55xNPfJyxy3t1IxgEuw1M57uve0XsHugPxfgRev6+6X08ZSUxMXNyBpE4elax0LgESYK03rGWVfevt+p4MCQHCvw7ijAyG2j2YMkjXNDOyl+i2wCrQWnNgAAvmOo1DUILxLgIO5m13RgSgTce1VFvdsCCcvhZ7HDZCYBEwW/bflOXXqjMbaS8EktPUlAM4WM3p8rRL0ye/NHy9FEthJ4ez5BEgB8WQz5QBWfJjijxMfbUMK4bU9+oAYkmG0fEBcHQQDhzN2/ZNneYpkQUblVTy6KIYxoPOnHoE2vYGwUz17pOdm4VApcPpsRTeO/PxRvGOpjQ06c12D8ZMF41TGDMVFnuc4y2Yz2cIOltGOXOimmoqM4Ksp/U6GeG8vW1XoNAeAcgsB1MwA02MT8cy6B/y+SIR6S3u15IVXHcpJsuAvK4+QZYp7M9bQ0w5rxRsvHHEVHwGILOpgaUUtHdnrhrKaloMY1nQcUzFy+vLVUJK0e351beKnCN9zbJRR87ARuRPG2dqBCeEszxqyiz4++4CZw8SLyrFLekEw2S+miJt1XaPhiQHlBpYEsafFotqSLD5G6nlMurlBZ8boimJOWbafNtqw3KM00g1qM+pqpbsJsEiXWqOoK03b1o0bFErGKXWY9VrPxZTygNke3VNism+ybnXaGTvB/N0vj1fdUdW5npcT+bNYuRvGefbIkGUS/HlS4n9XLWt+T6yTA/3D1ew6VeNidRZw+327POr/ydk83mRPP97lpxu7n7dfZAJtTZo+77wTlM+o+Oq5XiP+2HLmv44/8B/rie0Fv2Pw7wAAAAASUVORK5CYII=","tile_a":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAA3oElEQVR4nI2dy45cua5to4xsRAJu2MBpVON07v9/nN0wkNFIoC5EcU4OUkrjrA3vioxYD4mi+Jh8rH/+/fff/x7reHs8Hp+Px+vPKz4/3x6P1+f67vV4xQmPxzPOi/+P3+Pz5/p1ffeK8+N7HfH7+rDPWXd65vVxrGv59+V4f3t/fDw+9thee2xtLLpHjj+etr7Lzx7nY/yW5z+f+ZvGvZ7zOcbp+eDz5/lbjC9ptp4ZNIyxPh+v1+9Nn+fTz3x/vj8+Xh97XIvu6+z1e1JM4+RY1jM8Zhzx7DmuXMc1Fs17Xfv+9nh85HnfTOi4OBf/uRYriZG/72ElAUnMt1r8IpCuz0nlAnkiuIc/v9W/teg6Pj734sddkzhkxC8XRGPUb7qHCMPnf74WBb14MaPXK/4tYq1/7RlitHVOjn+NeM2v5qgNBDrFpnrtxf58PT7+/KqF0+j4DG3KV2doXrMX9oXndEZ9kXZk4Dz++fHjR0gAc1Xu6BiodkJb3H7oOu9OSQEu0Po7fi/itPvh83uQMvZ87abaE/tzPIf3A4FjJ2F8uQtJ0GMOb7h73lNE9m7Frvnrsei2GMMMkYuQG+D15/f+bd2XdMC947x11pCojVVS+sUwn7h+znF9fmLzkalCAuQftbNrkbyE+WEvbA2Kg/OEwHXmzrj/Js4Se+/f3zHx15Y+XHzvgpIwIsAiTDCnfp+TzfHtf11KhPQYjPzMBfbuTQnUCKbxXTaBJIXpGNfkvSQFNLb9wMeP5w8vrjcYpKuUrsa67uGdvO6tBVmfn32Ha9wxL0mDSaPc3Ov4JpHvCSWBLbo/yXr14H3zrU9EqHYfi/Z1rsTPs8R66sD1W+2s9X0yRywmnldPNxE2YcpGoai3RNBvGm/q4CDW09TDij4eH69fbYF9pGqKZ6Z6sATUk7ywp9Ssew0RbuqWLaMRbYbSnDFIqlGem2ognrVMCu14bUbQsNkA5hx/wSEkZ6Z+PHZe6sC1oNQ1bf8lR1Kn2wCKwb622F87cM7MkgA6Ng3KILZ2p4zXXAjpc87PzEb18cKzJLLX/WMudd0ar2jwnCoBIlgUIxNYKsUiy566qCbqd0ktMZ1F92mPaY5xzxelCTdmbVxPl9a+dqsJF5MpEVlSQfr+9fj4TAtzWZdhrUs8l+1f3sBF/1PPxu9QATXKpjI8zlj4XCCcW9Pbz11z/D/p8E8wkRiItpFFe9kfNrxeMC7hHW2G3Iv38/tPSz9eEwtmD6m8hFCdjQ4wQLlpP7UB3mueeSFVjK+HQfnPv//773+0MjUp6s/4LENDk8+F3oZNeQ8SM96F5EBOOon6/vzZGGIRKFwdEfKyQDykgtak/Tkejh1gAl5cu88+Hrq0VzdStMKtFsu9P5MJcwfL5eOGCO8qNhfcZtLswqA63zzBcSdNSatQqyldm/qaLvfb4/Hz+dxegAc6BlC+/iDo232h57We+HdY//nwGGx8ft+7Pn3++EyPIQd/xRisLrbx6HtZ533hrYBwL+wkEbysbxmFi6Bl00gN2LrP8+w5pATxM6GKbjQufu3ew+18rkub42CEol3eldiHrn+9ygaQuDoMl+DgXJC09GXtkrOff/E/164IG8EL/56c+p4icS2cduN7M8rkQ4uotIiBFuRkS7xegRxgDtM2eNBmWIsuK/piN4jQB4gkDAVMH4sf95IxDBuJor4Zs9y55zSC9kNqy+MQjcvoo5Gp+RZtNgNokXHSDTRofil0ye/l29ICJ3HX+UGAZd1r4dMQjB0sJghSFxBk4yk5nfdNwm2jMSyPbaSRMXIxOk6RHgAWpI6SOvv3ZC96MzogATeytsfbWI7Ak/GMuwvpzSIj188SgDbU1Fe4DBkRY431DDqk6oEX8c+P/9lAkA2gAesOdMCQ7maGFIcT1BiTDCKthY+J7sUW0FNuZDHCxgP2IRh42if0yeteBRvPMZRrCRX2RjUjDwD2h5j0kAT1PHs2eY9SAyJ20TTm9vxpN9O4AV1A/b0kyaIdvRr9Zk+lA0necE3tJAQ/1k7X7tPbYncQYl9GtwmT82Issf0IaPPUQYlWycB6pssY/v5H96/D+FvnpFpIZtkLsP8Oqz/PDzdSKGMM9L2MTOw6EXMCLk/uqvBi4IAmg+xzL+qEMHWOgW6dvYPFFG9lVG9meT5+v35/CWvHtTklq9kJCoGBpbbIrM02+CwGnFLVUHA7GCiBAdb0+lU05iJih4Z1jqCHd89CA2MiabwBF6AK8GTCECND1P21w72zgUq2exRcY0Kso+3w5ip9EaxK41Pnx2eIch+il43gYpIwjeau1jXYLM2Nk3ciSSabjLYNoOxphN4g8YMBtKu9O9JaPCBFWpQSV3k+j1hoEES7RuLagZ80BtfvGyH0nPd3cV5iBBR/dC0Pl27soDm2N38iktAZYdDFxDUSusc8xfX0BLYK/Hj8+v0bgIxAnjasxhTGG/6s6zatu5qmqim314Zo0stG4aDBPz++//iPxoM5kLsobYMZoAAotdE4GmcyyNIv1SIXmU8bYBP/I9UDrfr3x6+lXmhY4hn7cw6G7lj63RllbUEZSrD3BFEMQmlXz2cM1bI9hffD574xm9UBQ9X0di7BtK22sOtTmsydz51ettxgRm0SMvbn+vOCyr3+TKMj0cEh7p/fy898QXRvRA8LqMXHzjLRc1fbRaREwGczIJinTTrFqhdg+Pw9NMu5PXy/L6Ho8cwAr4A7mG62Rcpd1jgYdHok3YzaiRkPhi6m1aHAXY/uAaVMtfWOyChVt9VF3jeigZxgDJool/SX0b9Xj0EnhLlgzsMVQlx/u4EVM9CxASCpBljwQVxNngEijJM+b8PG12IUIR2xs5cj7OK5n02DzoyQJuGQAIo5iE3I1IH1f1/GZBG8HQkL+znU31rMEf3jjiWz2oX8kzGCAXyte3vtNkku2IGAICYUDKzYBlnjMg2ybhgGGhJIJrwrEe5zc/ltTAkEojoCXqCdu5Mp0pLNCa3wqoGXcK3WjtM85Pcn0MM1edv/aTs+Cb7GqAVitk2LXE71sBhqRA1jBIo+2iWsZ8eeNbMCg/HvcO04zjxfzylPYEufnciyg3M8X2smq2HjANAJ1hOPMQBw4rr5ryQ+Ex4WtuxdDwOnFvyMqTc9+3bCw3FNYgiRQaPgzvKnQ01cJMMBY49UsLQD3pd3Ah++DM+Z4YSFe7we70vamahbFaw5Nhw+xbQNRsLO3MkHrAx9DdXSRPfAAIK5fuwcA9FYdD08gDGvtyZeBv6szJTJtWvCO8pHAsWj04jbn1+6p3z1Ffs3IySjgDkkfmmTx3kxepwXOQTNnDzdPuP4ucgtGJNu5SfvmQvfglXF4JWk8WzuaNgv4c3omrpnpWh13N4eQ/NOtDOh10l3bf/DfklsJe2pRg8wIdeYwNI///7Pj/8KrYrhFWzK3TpTvDiZIWaY8bMTN17Nxw/3T3o9ibYXPhlIhM1JLWnz88dC0NKFZDIlU7eQzmZ75IIJ1K58ej7cNb7v+py++LTyGzwEOFjqQwwwYxIMDDXa0tpnMudAMb24+d+y0aYRudfS6N9YJ23ybRbJdYLvf0QIZfjJD3U4GKImCfMufY6dQ+aJ30OHFhNIIvj/35YO3oRcquXj90fFzKmyPGEkn2aOQuwwRRZHtFNJH484f42mQ7GgjufWwuDAPjYQ1NXcL+QmGi4fkUfTZ0T14vscl91WZh3HjXDv/MII4pASwcCEjyHd3xTnL5G0HlY+shZ4X9W5TcCP3R0ZhGuXptimi6eBTUPqyLVLkbfu+zM4fEHNH4/nq3Y3cf8mgSy9imjr5wUhi4A2Cl+FXh7JHxoHPAfTBCnWe8cXbLzO/Vj20PdMdTMUW4tuo/aywALW9lRel5QurbyAHkY408V8fO1B2LbJ87cbCN2j7JXTPcmEzozgVWh2D7KQQ3KggiVY/GUsEa3L37d4/2gYf+hb/ZZpToquCX3zk/xMWM0QeytJ5ElfWKrq8biMHyHi/K+sajGBDSrQQStDT8CGqRMxk3nSO6lA2YlxVGSwbAnTNxkmsunCDsm14b2gzpprCYZ6q8DDMDp4pDulY+28Ix08pcXc7VsdMGWrFuwD4rx0aFr2Yf3reSBILsayC46YP8c99SF0Ppno4dS1yr7xvXLxvJs/05VlhpTRwc48tAM6dVHEgk3Ro/aJX+hChZ1XwM1egDKK0ihOl/o6f3+H6GOomee04/Om+NuTXUmbC3Q4iFrWbHCaXKxmQC5Lvow7Zv+0xUM+4DTKdlbOllDLB7E7BbXT/PpYoNTTUBGT8R7WtSna/d1WhWtuS59f4V2AWkQdj9xDqAt7VVStn19EKofhF663o3lFe2cCxzrIRkk1ioTetmZJov2n/Xxl3sA3Td1I8RG4+sXKlmV9xOpzNwhq9e4DI9F3JuGYU7cTPiuNvDk+iAXIAH1/W/eE25X3WRi+metN3NJFf4xl6dhRaOKFY/iXqJ/GnPZFPJdA2mVn3nMBTxTSc0D6V0MAQ83Q0u9qpTGx6gJUENFSlazjCssubLry1qZOsvgTkqYgyQAx1u5f/2Ypk4spXi8DTbekjWCwLzwAi0HsRHsEDyaNjqPtyNqxjIqyZI3FLzNjiWK+jK7U9RMeZg4igB2PyfYJE034JAaHckxy5TE+ur07yXePMQpD6mEVZToSIZR8sP6rvPNhK+ydT667hIhz969/WxerLm8XWsSEHfLc91Q6U4mxNC6N8dfum+J3XSqrv3baaXA9GgAzmX2oFx3K9RcGIbrpO0RKLeYp1o32PQ6YXWlcOwjmu1xdVXsxN68lnl1gFpHI9fmb8ucsyr4/Hz++/6gJTJ9yiUWJIO1mQaDcsQrCyIJOD0I7OP5Wbh7FoBZhr3kljGohqS/bBJOB0qj6+JPGpIo7KAIpBj+rMMX3nFInCcqcfvvXRZ38/7p3Rez2eQbDkMv8fstWdtAod69GRqP5+8+0o2CEsxwMEiP+fc+SNM8pHxe7aIoWZbdKfGuRcprNAwidOgwaPd6VNaj+s73R4VQxkI0019ntey4/ftsQKJ+i/ZG2QUX91tMKetZCtOOtI2PlK5+h70ApWbfIdCyNM6VjU13YbZU0U/PVs007ueRr8Sm5HMiqCquGa4gVMT7ZPk6CHWV0a55vrqQZOnD9He5PGDMYvHLloGOW8dh0nqHZfX5V+oJYOFrgRdUtjEqDmFGTtxBEEp5RrrT6X6Pihv6/a+Qf55haYIYpYw3xBCL4+BrkoSozTZQ+FhOvBI+y/gV2Zd7PMIR7xV6tBRN4KTErKwiKxBsadQHK2z/ct4itExTqCZaH+HLotYwvw8i0ESTqpbsMrGzj0dcwfyB31y8Vb2q3IY2NamJj4Jg8Qq3bO3k0US2V1VPiV/nbHlfYI1x8GsEgfkhJZPTIvpnp7lKxvm/ubnliO5m27IOz+FYQ92tIl3L5nOhqo50ctDzd3DGsx49bfy5IU2gbdj0MmCOFOplou0BI1MwB/wzCo6tI07V7QBLZ5ninidWupOW9y7Ik6hXXgL5/vnrmb2TzJCL5XD7+flrsNsCyZvDIFtYWKdVFX17uqMYUsQvn66Vximv3whXTL+h4j0IYwQjEwftxhVKeXyqg0sx3R5JN/1+P3CyMA+D8LQHIKbdyIvvXpwsiLvQC+kEopEzosy3u2DkyOreLSGStMnAFc7oo0uOp0a9zVnaSK3sGhiH3lGN9JrBiz8OVSxoHIpfbCEqjNtWVfvIuHVnNCaSJ6Eqpl6FM6Hdn+WQCKBnSkPo2KFsSSIyzNoTdRzIQ4eW4bs92ZwWjzr0ydCogxIwY35VI2l7BXtunAxLgCI0KpTM8jPRwgDE72iZ0r0fAvDOaF3H+l8Yh4wUP6ldCvB5//d1y+OTXm8idqa5zhMFt7CAEU+VdUMruxBfB0K+ehHpzK0d0cNHuSJDBuNa138pYg6jKBWV1TKGFE4TBfw3lqnlDz9mv1GTpvZGGhpRx++J/UgcnAa0v4Wdv0GgEhjQul19te6AFRF4DwMmiFTEGmdKLO1OrYbwa6cz5CYDheFotYtKmDNjfhyUfm6m514P2gIo37lIAnVP8v0gLW6dGQkiJePn2VepsOIjGn9ww5OEVAFHpVHJOatIlVSzavQapo5UCTgmTeljFF07IsO2BUmszQSaTZA7hNNSMsL11w8r3hGSh5T8Xv5DHSmNbTDv7CvAZzWW+3RcGZtk6A2Oh7l8qg6nuIwnmSE7FOL7N3LdOpHJF7PYNpI/qw4vvh+BhmkC6YHuAS9cmjqCEShOgUDappULlKqO30LRyFVlrsEOu477KrX/b96juInVPekPNHZ2MBLEvZqZaa+Fp1/qntS9ghiif5oyCGndos6TLMDIYpOj9/ALdvB8FBYdIwoSA5DWkcGStkhAONaJLhwC9ZkfQt+ZA4/cdat4IWSZcwNVb35/Fmti1++7qM5bnVl+gYxGRAu7ahMDs8064RrkQ9ISqKwdS1FJd+aD4t4u3/pWx5/PMVJnsYiOweh61Ak8Y1a3WEc+2K87YwNEmzpMaXS2AoU9DbpaQs6tGS3ikTr5lBqeYbVnFsicGemUQRzEAGnsiIpM3wvL/ZZUh9aZk0XeN4cD5oftnTWIaYrc6QUcJtSi+3wn5tvQtA2g9KVfgV9+EI4JIY5eBHxq0LEPTswkEcZB5eVtUB3b0u/Vn+fMts8b3rOjfJuLuExA7LBahTq32cHVtwck1jlisLESRK7Z3cGUs4a4OI+8x9F9bg7qUNk66ULHKg27YyGPI75qh91yFMinqB2zuxlNT9cZc42rYJyNXMw/r/2acV2TVbjYlf6qHmej7z2oVO8uN2NKluU9MrkRrlH1uN/4slsWFQ2VEZi/LyekKqiYA5VOESls9YROfSCjJYkzu1pu7+D576oyEllYoOsrGmsuHXWWj49Z2FnTqi9MlBr0V0qc9b7ic3du6FJiOUrX1LySAIls6bO0Tz6Z0cD/bhCFRQq7+fQ6rEgAB6GER2txITaR2qcGaibtHlHDlCqJGPyVN6eTBICQ4k1E/B5EjjZ2Q9a1JxIhHaJDMF8x7uzSNSTZzTBLh8Rkbi7bSrf8gpE6zu4ZN0NLaYaTKho5UogMooBihWzH+u8VW9xJoA9jPbTqxo30GTFhEmsfW2/W0/XuVZm0PnB1GcLyqjmBLlZrnhyKZUgLqxWcilbi3jQCJUa5sOsuhv3viBoM0lToPdFIUDDd7u3MlNUbPgZCovWFk2UeIu/B8gEogiX8PFaA/pnVZlUHAAXLx3PbkgucfiY8Uj2AOR9OmLhzFH63BxBfh2qlmqsSszpGYlyH5688uONERDJSGmcvRRt6imQAqx6qldQqrSGLVPmKxtEDjkOHniibOj9cGIeQSjpx/tKez4deeUWphM0AGSlx46Tj0HW70Tej6xUARmhw9a3yMAo0bSLEJ3Vu/7QO7PEX+TCT9Sj8T4ia49biAMPfx8EiGTPumys8qF+LIWJ620wSv7KZBajBHwffRuShYGX2Ayih8doZAoyxtot0nUP6levTM0iQTc7heqhQ6YEp0vhr96emqeBeMRdA182iNpejm2ednSXnfvXTVKnT6PCVH3psSx7/TbbtIJqGSk6Hod/+tG8jEXA5D7/Lb3nAA4qyaBTbBKJxpYdEgomXDpFiPEwfgk8hgTXT/3abqc7dNoIE584VQ8hF+XqL5R8fj3T8gd5gKTO2idbG6jbBiAmXxePFn/6G3LxaeUgaMN/W7ilxUx7gZsdtRGxSrbmpbJE+QKLN5qcoUnSSBDTBVswzHU8qaSybsdO6QchnCUR7euBOZLiWdqySrmEEW/2kXHPEDnnsTuZ9nMklr+6qgQoo2qRdyc6vGIQOhEolqwQv+SemBFjZUK1Q1DDqp9+8Xu/pvEuF2TWOwvHZHCssjmynurQMaGNrdQpAn4O9xnvsDXAsfuFi3V8eMsmlz2s2f9Y5IuAvrerSTJeeO3jnVH2CdX/WBreFTnM9Cc0b0Rq+Ct65K6orqWdRsCM5lpJZFIOv1y80j3cZultppnhPt00GjGaHjcO/AELTXLN5vATgk7HATnU2ipH/VOMGDulfIcsFKC/V4d+38/Ws1NOqiSIWOvn42SaQLmdGur/IADrAmAamvoF4d1Y2sL4SbT9oWKDGsRhNxwCsodTKCNSzqQLextosHwx/HBRyiMcnuYfmjGbIx2s4HgPhNzjYhkH2i3+zmEJYZrqMnyQklSKI8gSpCSYEwjERDmu2+GST6akdRZys+L9XFXIfWmu6x6xSWqkAvopVWvg08iHh7RLtOT4yq62tR3o/W9hWwybQ0ADXV42AafpcQMb8eKkNBprinNmlEWfvi8z5vXVflAqwawGXEwY+0a7hRkmut2TZc2M+/RFfjfs02kveej9fvNdjfF2+iDhlRhQzCz55MMP13/B75d61p5cdRzZsZftuYTUjZQaS8lceRWTeqZN73zf5CadxOY7na2SJTKD2qryDftqNN99y0soX+rPHsEHPkJKS4/3XYHLV23xY37mIPIVfAsb342sVotpSD4/mzL08lcAJu1j+UakV8nnpqWsqaqozU3NWb4An/Ym4WuxeDU2XU+twO774t/eLIxe92RIdoe51EZjDRPZMHNcErQrysLfQ9AUdrwfOzM6BJm8ip1P1UDTTsjbjfThdb0dcWDZQN79g5RNFOqeqtz7UgheYhKwX31EMrIwjfoayJGDUrbJoKkhhuEGmabVGlVJjGkQbh3V1jeM/OxVvUqzS9StRVzXw7xEBSjY7+zbewmAYj/iARfnulG0PySVeneOGcvIGZSMzXXHbgAX1dl7BKff/xuTtwaaA9syd1C4JASgyRhHheQAYtctkDctm29a4JNWOuuRr7ww/bFeNVca25I9w0oGld761QcoE/H37PABgi9Dn+Vkl7NrYmoPVL/QIMXsEDyUUJ1gKz+Zm5YdrccTSYvOED5RfPNDjbAZGSBkbz83rHlPXckAAs1b5Cs+BSB3sYLcuF2os5xKqADuxHuVYNKBqcuX5ZIqqJRlncspzxUsUSy5XuxZRqv/QCTPIeqqOnwyuty9028lC+wQRYVHunea0Q985D3Dei9LDL2tzMXJiB+Em7N1WT57UeAqTbLQnUTNMDQjvZdJWGUWTndS0/oHX/rFpVEVvE3JM4hG6phvTnVeDhDNoGr+J9PK4FnPfqzSt3lJkEORnYCZ1JJB+fVAW1U29ZPy7sULBo/XOHrpXbkKnaHIdVFeorU5KyntIuIIz87sun4Y1NJznQeiQgAmm0UJnQSypkYS/jDd/kKhBc6PoVMeocWAvm5IDCLUKWClvFrM+72ZOObODgGyjXbqOPMTEadnnsFPGP1jSSHK7d4TTwEZSRrpYd8ZFl6uxQNotX24F5L0mRTiIkGiD1i68ev1iioVeSzhNDiO6jtwIN7wmzN8bGm0f75urnNCj4BjhIx+t1Zy2pgFAsjwEXi7DN9x5RPLuft508VIMyfVxgqWe53EyqzCM10lZ+d/30vOQsbqatUPJXaKCPaex9FWHEc1qcAe/58/XXXV0uOW0Hts+RGl90+vV7ZVwRRs+HYWzRIWT9HjlsXDzRCFCjwYs4L63/KVLJkX6tClwo2xxd9+5JirNHavOAh+WmySImvCxC2wWSavKLoIZh9egA1yaoGDQKwnXSEUuozGYUpCo5BIvZMqLz9bm7i0qK6NhIPRW+uY12wauFDzeP29Hx5dWUNpCSYcinNI5w8Hx9fEPZhp9/gBTgqFvpV9s1RsXqXhuhurxmhnp5EN2t59iNE0kllCLWo9iRBLCeMlrX/bKhhGFw5y2WS/jlvPz9/d1JR2HJzE9I3F8Lb/oPuhmUmy+jSOj5Vp5G5lMnkv33/j68AJVN5SVmhEOIQa/Xv24Ilg7tvXFvKmaLVuho+fzS0QJ15PIp9q8cfBiqHJe9gJy4LWfvkprbx/qfgjaPyzsLEgRrXkHqfy/6BHk0lmmHKNk0mKS8GUmR8vu7G21mcE0GCmPinGrAMVNXyu+vF267bH8xgGvt1OYNC+3wcLZgb+1kGk6ARQXRjYrhngJ+qvtIfo/gUTOgbHwmY8QrZOQqjU7a0+jL/2/1j/kUZu7yiExlZwszUviAOM7PYk6ggGaWOPdkCt1HzS/1vdFQIQB0/4gUMh6gdHSOjfaUF7pcYDXL0iZ5e67ARDZzdhhTWLXFWWLdSQw/bARl1vsDi9tLJDZdhIYTkSQqAwUIV0GvSsgciScGQ4oWcyEp6hVH0H0bGPOJ+bzQdFG71LgAYwV6MNBQ5PI5oByuXk8q7S1rNP5p8Ob8WFKneSvXcIylRTIRcdwSoN7WRsPx+XyPVog9rWmEPg1x8oGNy8ipYyJQB0a28LvOZ0uVPRmR7GJ3iPDJOFcrHu80nB0/6s0gFXq2Z/GcdQmdFozvN+zA2Tw78LJtkspTqF0/dmme604mUGuRpT2YwrtZa5HPXHWELYkVG430Mc4RxTWb1u2VMQx6KDTqhEICKfRPh6iqBeBEa3Je7AHpHgZk3vuI2muXRVFpTfxgFqgX6T6rowyUPNl+xtdVhlDQIIcVxiBfPyNGZceOVFHOfDKbcMH01pNcHLqi2CQMH0816eelbbWqqSt8LTXbm24Eo7DWMc77yFiA8uZjZ2yrvOfSITLF0C7fLJpcJ87dxEBWMY7W6wYLexzN/Ss9JhXFDOFWSRSf5dYWXtCs6xzjey56MUdWLCEBlokbu8du9v1Z5WksJWv6OLt5MZ+Ai0y3FjSipe6eyFlHUNXEZy7E0UqfnlSWx+leslN2LGA2ScBNN9iCnZQvKDInHxfVG4hlaQe+gJcaNOuVV9ra73c1Vt5OrqQHG2gCbbwA3Yg0toDFerKO3syBPj5WVQiFo8vIRhKT0LHZukdz3lsQMqQWqYbnkEa2YdIjua6YKpBaP+escJKdIrrAcI02cZ507jJV37KzZnCh9NLc0fjkV8nYHtg8aIh0FEp0EVcuV0O5pCLYbJkLzejdjL69rWfX4ltqyY58S1Rx7Y7VFs8/ZUIICGzpgghmNGcIAzPFOa4x2jfU25Zc1V7PC2OkUzROTc0aDS02FnmGnIU5ODV/nQ2DlXEWVAZdSsNaYENOVV8sL71fmPCXZgpgKJ/DoxmOZ1r2cTBRVRMEM32V1q3fn2JKqInnV+NKIrJgxQ2u1cSCz+WLMPFZ95v0baHxOd9L1Vbs6OcPS87DTRxSaLaYE5MUA4zJRtBqJGqaq2Dl9zQuxKp1DT2CuYheELycCgxgxEz3V6MkZAM3poHxSouY7g8zbF/AEwr7gOUsWBf39zONBeR/Z/MI0vNt2BkjnH54T5M+X7y+90jSRTVWdRHLiq9RYqDjW3/DBFAiIlljoh5Afr+J6kyBHNyAkCV+6GL6n7JrCaLoeXyBY75BZC1+61eUcQdm9jCrRwskJJB5J29dUmkXGsgZTZ6qhUyPVvrdxq1audOrWuBBEilCyQqsZDLlOyiTpzbUKUFLjYD+LQwOwC5zKdZm+rZdB4EzFx5xGnfdWGcxOaEsbXyGF+AsVfi8FcypRWjRtnxxdFULlxvZoGWnkhWeYXEM0IQtZVQfHwfbtmQDioaMXNSPqo3tEgZGoL6BKFvX0d6ITviaINlwl3WuPDF7KtUi3ru/dRtXIE7P6GOXNFm2z+4U6hMGyJA5e5JW8qenmLY4bR4CLHVdnC9P2Kh3+bvG5WXJg2l2kqdsDLhSragyASRNFlZeQ95GA8xnEo6AVhBxVtKwK1f41NtV3l4R4iBgMsc7CUKhCQXHpPlUHKTv8ALK4JDPt6Bx7Ux3SIH8mzbcXhJFltRUmIkE3mnVPrbpdN2o+b/d1SJDVVGI3kjSn6XP5XdrEXJco5FFg4SHbdLcPohwWtwvzpcLwtfH5EIoxTo8DMQWpAbX73qly16s4anIwucY8xU78Rtg3N1qVz7Vq+guSSlXT/MPyJkLW298aa+nGfUfe2rAsA2TWkd/gRFMQuLLpl+1D13h0+2Ds3x8u0ZHn1ymP9NQ0yiZOdsCQgNTnyrujd5AMoRPAWOJwCPc6zItBlPbke9GRNlZGYqZOEpJQTvr8/H4/bm7iGn2XVqDEa8HgmhxT7qnawybNvYCJh5fIeKyhIn8HeJfj0U6EsUas3yOhgoUyRZxA2mcoM2QBLpGBERcDXHBPvbHkFKtn07Ovwpi8u1hs1nlV93RtAOVjs16QS3yEWQanoLeV8R2L8PHt7WvTaJ8Aq2dcgkcDaSRqFgAs0nZi9ewJOBdBnUGlOtCBRkk5GgsGPXyPJe2hBkBBtCO698aT/TPug+lmAxOd+p6u3s3jO5tlxiFKE7u3Av0u70htP7rjuX2LDLG8sx3JSVqV8hjva28sne6/x8e09D9jY50L2NOTCTJhc+5640k+72Bqd8cQpRXMF8di4UmstcFIHrbUu8O4OjL7lY3vCCfz7qFbuwMMc7xZii0FonZzs9T0TGCSBtkZPRM97YVvc68f997L7IV2tsOUBVw9LFjDSsPE/bCZpgq/mj0hlf2uzXzgPGsgJPml78VgAoLfTNCGR3x7t0mnJEM6nQmLXTHoTcrwc2ZiZWjwndMrYk2J0m0xbpfZ8OWcYDWcKlsg9cAhZoLu/7LHbTOcXfPsgfKwsiRmEEXFr+/aynned5zVjYt2qzNlQWn9BCakSdPgbUPtn16VRBt0Z5qtsf+z7//8+9/8jvtR6JfXhF6GFhzFzS9C3a4va+OxhTu3Ra1SZh+EOXSeA/9nTvnx9yZA359jBcuzEaKPqY0vNCB83ebd9CP96QuZh5i2yRwP4/+AaBfs824YW3f9LVzzsHz2dPCZawE8dDM4fDzeYxkxYNwIOCJsY+CCQMd9Hcv9/0bJM3fadV7kXrw6ZXSrBH4hp1DijjRQt4BPQN2P8NurBLw4cZecwnLTZy/s+9Cl2rDq5HRJyQx1fZSEy7re0ACzIO742bxHoOttcOnjEIVe9auni4b+txty5mAVPnWLSqWYzjZbbiBFIvsOTT76zmFDQQEiBLHwDbsr7e8xO4ZrKP9TWnIzTPrJI91waKL4bTpCZB5c7z2gse4z8ypde7b6Q+nscFXrsrgoiuoBRqMIWDD1yk7xe/Y605z8+m/ErMSc068HCrkSuQ9slJnZbAxNeqh3RCI47lj5y7t0dFiCttEY8lc2CFmtNTQ5gBGcag7tOsDQ7j0yzDwcGEDPCoAa9Z72tiWCXPE5DXwvI6LfgM8BPackybndQNkNjdskiU4eorGuxXeCiHca4eMlIyF7uK39/c+wwjur2D13HAO07iP8eSCvo6iDM2hchSa3ApVu89j6LqVmVkNDlTDnkIZ4bM4ZLbSoW13CQdfQBYRUTc3zswFKreDuIFFoO83iG5K19szTPSbr55h6kNnXzqPKsAzdbz19wPPGc2uG7CUn9m/gOVYFT6GHfV2xv0jhSzuhW5kCdhM76ehqeiKZhrODWv6jAaRGu8XVdi9XfwQYRXBg9vzfwFiNIHDRYJ45gTiWjJd/j0xgZzASj/XeNvzgA3IU2hy5HOkTv0ZoEmeY1XCJpgDnq7ahByHXgABm2Uyqd6J2HohcJdrfMrd57UyYPnOnynJKKFFOw5h2lUbCeS7AEfjJ9W/G+EbDxwSYDYr0JFCeX/efxyilnpsh2pL9zsWnoc/gdMFNtHX3Tv6lBZ93M8xKTxvIIkOfQ+drMZXpt8sr8uYgd5fJAYs+mBn531FJhvDOI8pbs1QFNOvamyFDhnswrwVIv9GxK4vihZMkKVE8vNLYhkY0WcWRWqc2CHXw7uYEqlBTENaoOSbgI3udfFwuHteTsaoNjV6ofN+0glAzazmuK6Vv/edxy4lLqPXSYyI6usMSdMtbofOhTHo6zJsvpiNTDbrGCWF9juD5mvP4VI4OYHn5SD4ijKHbNtAIVGmLreIhRXv86rfjm2KoYPNSJJO6pMzRPYsDKH4iyPHtNyl9W8tVuxUHbcsXC+MkDjGPWQcJmPkPXQTo54GZeChSCU0Y5PeVq9rbNhG/D2adWjTKugk+iVzre/etkjSRDsM7IFigSTi9nc9UNEgS8HGt51On56Qrw2WHXUrGDmzjVM3bsgaOtiuZ8UTzBDSr5niTnfpSZ8c6dQ2dI+aQsz9MJZRRKNGkliszaeZa5l4PoNHe55DT+P7VmI+mZhiXqbwV3Ya6wWjWfScEPxl34jLn/l/O8LAipYhWm0wJlBC5mpQaLkwtbPWq1/Vx6YY0oYd/u6eRlr8MT4URIbroNcIl4R46V70mb0QPZVcR4xLM04Lfjd+lGWf/ftzvTw+SSoYem1B8/MM19Jwbcym33OsfK/Drc/TLg45pXBkBO1F7vF2cQmBoH1Fh0gtnlCz3mIKNJ6i+WQPE88gzLrSr2CL35ARozPG+/LEuD8ZqpVffLxscrimn2WAEmFru4uE/Bx9EWI/1FvJOpgFcT4MPH02QxLgas+fhp7o1t8PIPXwGrEcNusWrX4uJs77xGNUHOnCRkWrZJUnIehqNUTQS1c9gTmJk4n6f40kQhqUPbCZwFk/IsgI2crPXXpt77i+uOv4gc4hGfR+zACQxWOKcb8ddVj+Wx31hWGK2yzxCuZhsQ3xDhy96WTfWG0Hk3ked2ljVTg8hZCwca+P3R8gBjcGsm+APEGxgRGq4bb4IQAi5vsELj1+eYaVzdhBhUJWuzkRRlZ8WL3x319wcxCalUFkqSVgS8+7t8jx3NJ17b55GXLUy3sRc/Hz9Xhua+MSMxi40+gT7WBgbvU00VEYzLPjOOZxGrHKSno/U8I06RYFbJyHWx4IWpZHSQzfyrhwrxlXUGIq7YMIqwphA9ZNQ+nWFmZWNGm8R3/DzyGhyDCQet5ZzfjE27mRpRxj1rxGvuUMZpGRGchp8DslHnDCjszmb8PDEZP1NLbqF+DXxzfdMy13WN29DWlH4mauwC2iWKJ79sLZ429BlQmBwk0iXNsW9YsYwTRw037zQUjXjE+X6tHDyTfCrsPFr+N9hTr2m8571C6M2eV6jnA14/fVN2CoUx2y2RJ08hw8bs2zG7aBAzSjjZNmFE0PoesjEZXvFjzFe4/MtUGY8rN/3d71OjtgX6Y3axx+nyF2vJBLp7RpLiRSid+nJPUIkBgKzsaKBLqUS8e57kgiLXO9JXX/Xv0Eiwpqu0PfXR6IaLah+PIKyuu5WPreVBon6JK2h6OzmbCyzt84gCpu3vpOLKJXnrkXl+5h5J2ltS5Cw9jSM8oC742lKnqY9f/c5Re3sbl3ttypw0eE07YLRPZNRawDnkBrH4dd6QwdgD6nz41XysXNpBJlnW/GVgSS2AuziXuLueV9wwi1gddf6WOGFV020NIk7m6Jm5VBmqDeE2QRkkUJDc3zAa/gRsTh97OuTdxvI2fefzIa9T0CMFYDh42CuDvdIVrZGcB5EpShG0jR/5fjCrjEmNiWfuX6Zacj2zgMk0P3IyNL89p0pBfWXUbGEgrXED2KUTfjSm3+jqu+qUaOYVwtjERS+JafN6CnFk7ixnpUAR26fCp4FGhB8UeY19Y9Lflu0QtDVCDItX6Hh1I6tIWEYZy+ZKfkV7Nwxend+YzJGLQRtjuK3H8wwbXRlNVY3ktdz0zTnBPzC5zE8tuAEzOPWmq57TJI57xfZAQpXh47P7N2ut6vnVyhGcCxdN8iVr8iUSvunS1hWw++SnJouQC0lheocgWeegKGwKHd3gaG3QB2CmnEW9AuufWv1uuHjJLEjzdwFBHterHzhrEIuVq9Qyp7Ef+2Zd8bWX41Jj+zHTBa9Q1USaftxiGETygA5nyA+CLFg0uWZfRJJ8Ovf043Jg0Wi650fQig2BAZcYWwnFU82ZJAR+QMWISjYQn++Nf8nji7gaGxWx9vvfrGB3V6FoEWEANGUZRUhE53dbeBzQpidyXbPQgJBlVc5VLidVFJpU5L9bGDW89YEtX2QusVNnI5dXzbN9NLk8u/9M016Rn71qJCr0oUc9Luz0fsOgfsRXr9NpAjw8Wi06FWqKh9UbxraAE/618x5qgiykVk99Cmzp5YDBKeEnDo+KkGjlA0sRM1qkh8wLTNQFlV/qCZNaOzkymGF8VUNzNJnucmoDkPu8CIFH5z9gnfSo0JNdE4WqLJl47smh3msvsVxZCrjRti0Q0ZJO5Aa7wldWRoVlYxGEdAkw/4zF4ojvviwbzmK12ZAAIJ0P42HM2V6ePWom7/funp/b3DzADTSmpV5FQFNdzp9ZyzJ3PVQZSbtw43iCLTvD13rUSqr8ABjDXnAyTOaHA1pAzn2YVMkajJyhgSPh9uSHJrxe67UUKpEwT4/mO/3RsqaFvsZax614wYfjD09x+7BesoibYofYghaPB1w7LVGEj1NDe4FqFFO4UX+Hk9uqc4w+rzM43NaW9NgzXstjSAi6HKYLe0znE0gz2ZQF7UngbdhAmNAqAwhyl62OLQkyOFc6//7qbLcmHrWYlwGTOA35/vHo4Gjc1N67X76m9cLuX5Otl4P5EZBA0T3oYbCp0rCNr4giVe4gkDvJKCstF4Mx7l1TTKGi3x+Mv1A84w091aadlwhS/h4BZU8poLCuYk/gYJf36RnED4lTh0RtIUbfSLIpgB3DDZERBZ189O48P13ImYJTWiB1+cVy+Ruvn4c9wvzinyB8quYVRvFm20ELLTuUuauNnjyE1s9RDzGNB8rMsI9AgRZGJJSZB+X4a6JyS8LxGa9PaXOrRkrMZFmrTeFG44tmftuP9+3C/brwLEaITwIMfrVJsIwz+UpK9Dr2vtTCOwBSpIEuCJnZlzCHOm1fmPF0MCO/COvRSWrnvvYprug3tBZhBHY0B3Mrp4DQFNhHavC2woZGUxjnK4h+kGZkYQdIyx+YtfOrjdC5iZQ4YjASJ5MuGKoBFlTojwbSNG+vrN0DMzdALV+PLcNEi1e19/oIcbMV94Xhl7i6D7HUf5QosDfcvdj/rJW6q2K6s0R7uiZb90PEILnLkGaiSZJd4y8BpTKGpLJvMc94mBOSRvFMi1sdqdFAoC70XEIshIsnHWxalBIunVxBCOnvnphgUjyFBcWTw/ftpF64mQvRlVTwjtRpGILQzDHgHv03bvfm3LY/jfDCjtl0LlCy0GBO70sRy3vYmbRHcQ56xpPGBw0NTGI+MkplEx90r/jpQ0GMU2fJleJoIMr8Cvj596x2LNugNJnEOnNAQOE7fxIs51IyqAOG7OfCFI3vcgHsAQa2pAqbx/gScl9v1OhFfuNc5LotPxeZSV/QX/P9xl5Azw91a8Oe2Pca+W2EpDkPMiROy5j1axLoVHLeTnxbtlFmuJTD0Q7Uj3MJvla0s8k0kIpPjgIqoV2+e9d5Dbq+p1EZAMdEvt8Fis0vtII1Oon8bToNdXS7SQ6vJcmRiDudummDDsQVUsQurugqmTfW8Z0mOjcbanwb0kbr0FhWntzT5gXCC/2xLACyGHBJ0z8rfDiNBizHw1PgxcKyIukR/9c4mb4yUNUTyJYIobK2mH/y7VQIuWu40SrRVZwoNpsYh1TAkDH5uZTQybW0I8/pJdpHsfi3CO/7gPx8POLBcv4uiLPMPeRCpxVIMI6HMPmtg3IEWaiHOylAbzZQzMkHGhIsXWeANW9Qiu+7dMZHXgsmHVmVSivnXcmIz97H14m788chiP+PtQGz5QSDs9qlOadEhazDLtC9/vEnqfXsDxfkNKPLy9ZX0KHGB2rZg+IxfoqmNvHAsGaB2zzQTKk2NixdB13NnTtbv4tH2hsAOT0c7MoMe5MIORy6X6wta46eNJy1xgPoMY/S3F6yv0ctpmbT5zDOmxwL+qTykNtwQggQmQiPjjZtPYvUmBljeYg2qdvykJ6GbRoh/JkbUQjVQGQ5il9BWgxTq9x9DZLa1tGLSEeu3ekfgXYIkxeh/NqBvvMzxXyrQ/cion7TnmKY0uxr2k2D//73///Y8tTi2W/9ZkQDcW+dPQagDLpYX5ccw4+PAavFP83KGOeB3RxYn63XQy5vaAb9+e1CQh3d1zwacNVGpk/j3GgutoA9T3XWJcs5SGUSg7qucTnDkHyyt728kU3c+Oqq+ctCOCXywuW8LwYWWYjcXg5K+O80WUeuGaqdQJCAu3UAB6BLzX2ZWsH/WcFk5V2zsgkaYPxPxmFrazKdyD9Re0PQ6XdVQ/zdgDJcE0ZiP2QUknM5b3zY32dtyY/ixi1YVuDqMoCWEr9JNQxhmnbgYgCCEDrnx0LjzbssEK1s7S93DLAAW1yFr/f44N4NKEWFvQSNISKB3BpmSwfXQwpr1EE1K3q5NRCK8SREqtdNl7zcZGDis0DDVlRqnejVrb6hBCF0EVwx6w/NK+CHVtvtZVsXozFaZisV5982UkqhR8H5f3BXpxEQpW5TEbJ06GcGOqoRv1/Rt287MWb31Uarn0535Z9EYPcyRjjMAaEo9QGrfOL7QSOECDg3tjLM1nAkeazzUvYJzXaM/z8r717mAQu/n1jFO3TGAwzbSMc4gEXsjFzSMIECO/16UTmRyAy74f0szl/qH/nZ7b3FWNBSLwIfhYz5oNIlrjh4+jv3Gr5gWBpzH5nKid7g/dPXd6XzVKmAGbJ71tr8itRLxjl5ZJmta4HQ4+WokpKCQj7KbHR5dNWtM8Xw2VroYgCeLkEWIAEyYZFjQ9CHYfH+M8PuP3Z0Pzuvul+R1G8F8O0o7YAcfnyCo9BTPhGOeBzQBZFF1vhq6SVhl0G/NzWrjei3MWYGwB1na9RZAehu80aIiZqfMr/atXxqxzhAc29YMdvsfSoVyKzTZZLKqyfiQxnOr90H+1q3ulkkT/8RLsJKLo5ZRvE79eMrFHyVY7JWnj1y88Ed/rlrYH6cGwNTO1nD6Wz7MUROaTp+PXrfzJ+D45N7WYRY8OADjBj6NNXHONGtgz7qGJeizom4udxxy+r1zIedgToVnIt5y8TQ+h+vvHWOKe19rpJjXD8p4u2kUP73I0SZV8OfVtt+Pv1pNoQO8FelUD78lI21WfuRV7Pf8/6gKsU+olhqgAAAAASUVORK5CYII=","btn":"data:image/png;base64,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","btn_f":"data:image/png;base64,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","btn_p":"data:image/png;base64,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","btn_d":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEwAAAAYCAYAAABQiBvKAAADr0lEQVR4nN1ZPdLiMAw131BABx0tx6Cl5Bq0HAOOQMkRuAItHXRQUlKSLul2RwyPeXlITmApdr43kyGxZVmS9WObTkopjUajP+mLqKoq9Xq9bF+O5h3+0fun8uXGFEXR6ZixptNpms/n90YDC4Bv7csZwpATCDQKVVx5vgMew+9lWWblsDaP/ng8pt1ul7r2YcZaLBZvC/UbES3ObDa7/94Nxthut+5gey9ldXIrr6FiUK8BP7T1+/17G3/fbrfn2HfnAMBHeTRFhbWbI43H4ydNV4212WxcRm3DomoZRmx8RVEUNeE/yTc6BovRBKYzOSaTSdrv92kwGNzbfrxBh8OhJmwU654XRsqpsCYYHh6vfD8tDJhD59d5Pd2s73K5uDx/PKXNyyCs9lWOUtqm4atC4x0PG4efCKokGwZ8MIcaCDJE3oZ2y+sezxcPs471et3aCIacV+kYbjMlvDwEnlgwL19GlS/nYZgP75Hs1m9h6KFmMBVMw6If5AHQWWJV188pZO1I7vawRz/2PY2LgrFtcqx6OMbnZON53CqZy1EGzwi8WpFRuV1p+J2FzOUxDTuWg8G8h8PhS3XWCs181OOfBvOMo4I3VZhScgMbNjI+FIgQGV8NyN4AA9qv8bd283zPmBw5PB94eJW65mG6L2JlWPhKqmGU4DVPmAJt8hCHJ+bVX+Vj9Ern7R29UNRxnny1pI/NIbtoLl8MH4pznvK2CTouMi4r4IWDekA0D/P3Cg7z0ohQY7GR3KQfnSOb3NgQrbonPAvcZiOpUK/V0PFoGW0qam5bUwtJVKWmI08beInU27watAAobeSdGj6qpEWORQNyHCKJc1UkG3Kv6ns3GJdvzyCeuyq038sJmodyIaP8ojwZ7c/YS4zX9XqtFQaPNxehaI/oHo2YkRfrpSibyxvc5wmc2xJAcfRrLoy2HTxGD+8oJN58MFDutPFiMBPkdDpl3b8vgnt96u4QXouEd1TRygbBoQTnMXwzDfPhUDQgRCNdjNbmtPO0F5K1syQYLZfLF8tq0u45yR90UelmAyuNVlwGK6ynCTWwgkNM59eFxq/14SypXtb1JsThm6GTVJmr4UgYCMALFHmqzu0tkI5XOfnoxWM53HT7gnY7S3o3NbUquVqt7H4/fYrqgyvtbyC3eE2IqjdfTTNqRyO7A4rugf5n9P7hsrHtfwE1g53P52R/hEQTRh5TyWrqUSK6usnh09tV72bhHZ5NNPC0zoP4q3+zpV+Kqqo6fwE+2gUDVvXHdwAAAABJRU5ErkJggg==","tab_on":"data:image/png;base64,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","tab_off":"data:image/png;base64,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","stab_on":"data:image/png;base64,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","stab_off":"data:image/png;base64,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","chk_on":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABrklEQVR4nIWSIXDiQBSGvzKIxSWOle9c4haJpA4cyMpKKnGHLO7qrq5I6q7yJDK4xCXuIoNLHOt6s8s0pb2j/DM7b3b+ff97+95/JSKvXEBd14Rh6OMbZqHiKdJ03WWz2ZDnuSeapiEIAnq9HlVVobX28RSmKhllW4bb7CjgklerFYfD4VIzLAfCyDZM0pIMReeUdFW/wuNAmAO/84KtBQUfBb4SuYuFKVCmO2Z70IEG9amDcyLLWPiuwBY7BnsYT6eo0NWHjgtS7IiU8i2dirgzCUPmjrANgxJCERaLRTvwrgXiMueXKAqrWNeWbWPR0scAP7yq5S4tqJRiZEy7Md8BwBzNOskwCn7qgDzqM1VvyVCkGesGBsZ4P8Rx/C5Q1zUiwr1VPCZZS7hpe1QlEzc0Efoi/8yr4xSdWXpas2jgJd2d0JbrYo+z0Xg8/u+GOqf2lCjiZg8vyVFklWQkFm5ub30R59DP6LbJ0kckxhjD7PmZP+mO+wYiY/wXHVy3ZwWMGbZVXPz28EAkwnK59PdzuAqC4HU4HFKW5QfCuv3izXYWRVEcBc49cEa5hL/uUZum7RnuPgAAAABJRU5ErkJggg==","chk_off":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA6UlEQVR4nJVTMRKEIAyMDAV20B1lWjrbe4Z/8il+w9In2FpaQmd5N4mDw3Cg3s4ogtlNWEKDiB+4gfcejDE85pD0GscRlmXhhRACaK2hbVvYtg2stTzmmKYJ5nk+BIg8DAPs+35XDDiHoJSBdV15LtKflPWOjOig7/tzTeRBNZFIziFKwblIjUyQ0bgrkZzs3DEnnqQPcj0H4gtqiCd2biEUKrhCrIC34AvNQdlj2UopfmpJJHVYiYyIP8ElEZFWcEWmRCWv5BNyKlIV6Lo3933MQkaR26lhJbAAXYzY2/+i0VpXr/OT4/0CQTBSHoUffnsAAAAASUVORK5CYII=","scr_bar":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAT0lEQVR4nGNkYGD4v3dVD0NKUQsDsUCAh4OhpamEwTushIGJgUzAAaWZyDXgB6UGMAwuA35QagAHpQYwDD0D/gx0LPxAN4B08APujYGPBQDocw3/Ovl4qgAAAABJRU5ErkJggg==","scr_btn":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAArklEQVR4nL2TMQ7DIAxFf1AGjhBGRsaMXRmb63Ts2jHHKSNrj5AxY3MLVyYLIRQJUfUNtkCyv21MB4DQQM+GiLBtHsNgg495rwuUNsHH+KfD7eHQ7fGE+T5VKfvXAudXCD6kqtUtpJm/oaSEGXU5AWMvBjnsdA29xwg0ItikE65OoLT5TwUqIyTQSH9SkTJMO6fOmwrM5QRm1Ken2uG7YzDzmxZYsbSBJcJnaqngA2vkOCc5y4XSAAAAAElFTkSuQmCC","scr_btn_f":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAg0lEQVR4nGNkYGD4z0ABYAIR////x4OfI9EIfO9YMdgAFphJ94+XkGTz1CnbEC6gBLDgMhkbUJTkYPAKdsJvAAhk53gxYAOKliUM94/3oIgxMVAImCDUC0oNkKCXCyRwGUA+YMEWVaDQxgQSxBngFeyEEVX4AHW8ALIRXwrEBxgpzc4AR0lABVsQ+3gAAAAASUVORK5CYII=","close":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA/UlEQVR4nJ1TLRuCMBC+8SwQoWlcJGo0GvEnGInapFkx2uRnEDXuLxCJRIxE2nwOPRyDPaBvud1t73sfHAwAQCml0Da1BBvKMu/5MpNwvDwYR/Ju7cOvEMKHhecqTlmDQMwmR/Ee0iRtz9z1tprqcpJcllXPd8y+D8kdovg0GesEwECRX9uBEQEtxb6VruwCcZR8Sn2LEJHidGcVCMNN+xiz4EO06GN8VgWITGZdFrTo2+CYCzJWtj6TgYDQyqHHRKZ29LgJbl4QgXrWRfQ5dALQy151G6kvzFhsIIDrSaAvYPrUrr697HYOVVEUo/1NIZMVMDzgX/WPwLNu2AtrH4cSO3iozAAAAABJRU5ErkJggg==","close_f":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA5klEQVR4nGPg4OBg+E8UeI6Cnx8r/s/AwMDA8v379/85wUoMpAInIwkGAQGG/ywwAS8nQ6I1e2VPZVjXGgRmsyBLGBkpEtR87tx9FD4TugIJyx4wJiSG0wAGhhdgDNMAoSFiSEbiNiAn2ApuEEIzsjjMEhwG1JQEQRVLQBVKgPkgcaJcAAJT1t5DsuUFlI8dMKH6DdnP2LyD1QAJNCGEZoR3EOLogAVdAqYB5mdkQ1DDAW4AAxyAEgksRSInGGxiGAaAkicCwGIAnY/uXQYGlhfHe8AZA5a2SQWMIAKUq8jR/OEDAyMAYHuCrH1ZQH4AAAAASUVORK5CYII=","bar":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAPElEQVR4nO3QwQkAMAxCUVOykJD9V2vpBJ48xTeAwi8OL4wKgPXgOMe/HEhJJCWRlERSEklJtCBRc2g9eBySA1vt8mGhAAAAAElFTkSuQmCC","bar_l":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAYCAYAAADd5VyeAAAAKklEQVR4nGM0NDH8z4AEWEDE+TPn4QJMyLIgMCqACqgRHuBQNzQxhAsAAFOOBMkPiNk6AAAAAElFTkSuQmCC","bar_r":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAYCAYAAADd5VyeAAAAKUlEQVR4nGM0NDH8z4AEGBkYGOAChiaGDEwMaIBpVAAFUCM8WEAhjQwADjsD8cufiY8AAAAASUVORK5CYII=","bars":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAARklEQVR4nGM0NDH8z0BDwMjAwEBTC1j+bwpiGNI+YKKl4SAwagFBMBpEBMFoEBEEo0FEEIwG0cAHEcuQrzJZDE0MaWk+AwDWbAlhSoQhDgAAAABJRU5ErkJggg==","bars_l":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAYCAYAAADd5VyeAAAAPElEQVR4nGM0NDH8z4AEWEDE+TPnUQVA4P+mIDDNxIAEGP3WoQqAwKgAKkAJD3AwQkMdjsGBbGhiCFcFAEM8Dl716rRpAAAAAElFTkSuQmCC","bars_r":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAYCAYAAADd5VyeAAAAPElEQVR4nGM0NDH8z4AEGBkYGOAChiaGDEz/NwUxgDAMMDH6rUPWwcCEwmMYFWBADw/k4MMayCwgAhkAAMuMDIuVXyKyAAAAAElFTkSuQmCC","tw_normal":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACLElEQVR4nI2SIXTaUBSGv1Q9XOKI48lXlzniiIxsp4IrUxTXuYEqU6Oup6pnaqA6ZNzAgWpRNG6Je3GJGs9lB7qxnTPY9rv7zv9/795zr8URPUReNdMFZQm2DXfzzDrkOzkWDjqXjMYzXBt8dcp1qKr/AjxEXpUagZCKj71z0tKQ5hpdbOi2Gn9ArEPU9cN1FU9ilOezSlPS5IlQOryerKyjHTxeNXf0b1/X1Woao5o+fjvCUwqpXpEbw/qqtfPcRi/ePeBTN6yWeht+rCb9N8iwjX9+wU1/wHw+4ywM0EIy1yXrD1HVdH9BrG04DMOXmQd9GkFAcNbhba9DpoZQJJzVFgSeZDSdcUrJRRSRL2NibX6McNrchbUBP4wY9Hpkqs9txwVH0v9cshEOw+shi0JgRI16dIktwOo2G5V0XfKiRJeAEHTaAb2xYFMajE4RLoSqINMlAqiLAl9K4lXOievUqJmSuisJPXubJ3nW3LfBbAqErDOK6jiiRsOxiTwXTI3ZKsWYDSeDOLEKBJPZAm0EgRQ8ZymLZ82Xvsti5JPrksJsuAwVy0wzTVIrLQzTJLP2e71qqepmnlj3F2ElRcF4ZcjLgoaUmE1JJ/AYL2fcxZnVatSreZZbRw/pXehV0hY86ZIk36BsB8eB9/FfDumnui1VSSGIojbDUFHbLskVjBfJ7ud/Au7miZUUJdPpGFyFsOEp1Ujb3rf9uw6OsFXkNSpdmH19KLx9/w42mQiDjCz/tgAAAABJRU5ErkJggg==","tw_champion":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABdUlEQVR4nHVTIVDDQBDc70QUlzhwjQwuRBUUyNZh6xgkEhR1LaqVDApwsVVQiYMqiIxMHXGJIy7Mfsjn8zQ7k8nf//3e3d69QAdeTv0yzjO53mQFVttU7PLrdRGMlzNMXBee7cDe63e5wdKNhT8olRFt0HV2E23FvwwW/qB03xO5ZmQTzISgz4XXkFm6U3JSpXwwOpZ2mFSExJFjy/8qaJNbusHIvPwarkEBKV6NryxvSNJKXEJQbQqmavaHWF5eIfIK3IZzuXU3mcKP+7h+vG9pw0CCtes1M21GniVzHMJDmE3xsUqRzjMMnT5MX6tObxfqy/lbk7LpK84H+6Xe5/ynkJFYgn3mqMssgZmZvqI29FIYRReRhOwORazP6lnotVJOEqU2BeNFfiTiHs/ZgbhpDhQBNzkkZJd1RpvWKMvIBTD6bGaDUHPwHG8FAldOWJxmGBuC1r1fB27laxIokj88Ac27MM52ZmCCQ/KQfMt191sEfgFIH8CZR4376wAAAABJRU5ErkJggg==","tw_giant":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACFklEQVR4nIWTIVDbYBiGn3ITPy64xBGZudYFF3CZ61AdqkxRGaYCCqYKrnMdikOVqi2uraIoqOrVkaqlqq2iv/t2f7Md3NEen8h/l7zvc//3fl8KrKlGjJhzNoO5hssrCqt0G+vM5dCiFnfQgOvAWZQD3wWcRcgCcLyI/s0e2RgWWpFlUA7eQgqrqDKty/nJN7KJQmuNUjCZQbu3Wr+sqJrT5flaTAvDliXPzy2ZDkOJK0hUYfneaI4qLzfZMA/zoVgy5pZcnB4QFC3csMn+3j7fTxPCSgBzsF34c4fs7lgv7TRiZPrgiTHXI+ShZcl02pJKgEztJ2mqhjQjZPjLl7KPXNcReQrEgAxkY0lxO5wc77Nl2bg7txx8+sr55hD9CLtxwM9Ln3QEtZrPjyvA+oyzc7e0FqplJZNMY20pLKUYZxrbUTjtCkVVoqv7DBjg+AMeU9hUEB9v074d5xlMZhrPgzCw+OhZLLTGtTTFesKNbjMixQ0GuK5FyYWHfpVud4LJTGv4kOSjEWPUek7tUJEkmmw+plLfxHNHJN1tevdjGo2Agy9XpBMKCiS5fzXW8F+qpqVOEwmKyNmRLfU4D+/uGgn9XPNfu7aqZSVPHXtp9L18/mYPVmnfrLKhl0PFQh1ycW7jufA4gqRPwdzqXYDJpJ1o0sElVvE3aQaOrbC3kN7g7Sqv3W3ThjnTzPyP0Hsd2Kv6C+mZBw9YTJk+AAAAAElFTkSuQmCC","tw_party":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACvUlEQVR4nJ2Sy2sTURSHvztJJo+ZpEkfSYxNbWsfKgqtKOILRURRRDe60KUIQkHEv0BB1y504VoXiqJgdSciggurtrqx2pettlWbtEmaV5tMkrmSETpr/cE993LgfJzfORe32y2B/zoutyJF/VGVksUKDBfhRBAG05Az4EAYhpMmpqowmjA53KYwmzYJ+BRuvF5g6PQ6LMC4IdkzcIumeCsOr87ir9+EYnEKvmYckTjplw/Roh1IaeAIRajNT2J8ekHu1T0UgB8rEO7ZRGpuHk9bLxsPHsMwJYWPr1B/T9HS0Y35cxxXeAPV0SFOH9qN8DfVS3HWQ6cOyYkx1ENnmX35AF9vH+mJUSJ9e5m+foY1Dd60ru87+3G29tiAL0um1b6mrGDuP0I+m6f4/CbTz0HRguANINwayBrC34zX64NSyQZE/ArzUzM0NHVRTM6TuzOA8Ojg1lAiHQinC+HREKoPPDot8VaqS3MWQKmH8SUTLRbHn5qyii3pIatIShO0EPLvvBGlPA16CEdz1AaoXoXC3Lc1q0JrhFoVWcxAPoU5PQKFDNJYxSwVKVcNhFBsC2EVGvYeZ+LaKSspi2kowqXHw5SNClJx0KhrZHI58uUKwuWiujBjA1IVqGUSax1cvP8Wv7eR12Nf+PrhPdHNWykX8mRmJolu287lrhjOcIdtYbUCrs37rMT5+0OMjE1w98lTzIpBe2c7y59HcApJbH2EYCRKUBXUckkbUC5DQ+Iz524PMvjwEYlvkwS6uvkx8o7+3j5Cuw4TiMVJ/1pgObHA4nIBWSraFtoD8P39G7ovXGHnyRayqRQ7tnQzGw7Q2hbkqK9KTzxMtr+LTt1Jk0cBr/534PWZBc9dRWaToPpwNEYQUqFW34A0kbkUIhhFlgrWVoTbh1zNI7Qg2We3EKpwSkNW7e/6D3KEdf4AbDUgueYVxywAAAAASUVORK5CYII=","tw_elite":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABqUlEQVR4nH2TLVDDUBCEvzCIgAJHUQQXHFQhqQUFLqBoXHGpAxySOiR1DI4qQLYKUFDFxDWuwRXVqXvMXfJCyAA3k8n72bvb7G0c8ogCDKXo3OKU9//eRwHGjPziqYILzPRV78dPFJg5WVxev9L1nnAmEWftmD/j40hxq+417gyCbcy8vQgnEfT6um019WUsTWkiZ0kSE056BS79BC2QpjGnnVAPn2O48HxaTWWiNCXZ83wauzGnfoar+UAMjtCQShIH+99skwQ67jT7/tmiFnnMGnPXy961JX4qveNjtjZzld0pQbRA/AjDlwcidw/Py5IH8c88qkU4nprg3ZiRGRmOjSEYG/bvf53OfPVAGAzIOq93POgf4i77UAPcKhrmyhur9s6Lo7SZpUXydnKuOlRZOOWDIFhja2OZJBnSPIGBf487G2py9yqbBCs3tMO64t+GeQExknhBQkZlp2HVLu/7DzI/tFCjXs8/IXeYOLEMFrXlsYWEhcXZhoUG4du3w6qjkrX4QnxgceJK1cCKJzNO899A3FidtWDE/+rAUpMCpPMvRbXAX/dfjNzc5H0xqDQAAAAASUVORK5CYII=","tw_unique":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABj0lEQVR4nKVTLXPCQBTcZCqQxYEjMjgkOIKLTB3gcCCpa/sPkIVfkOJAxnVQBEdkZHAgUQzuOvvK3Rwprjtzucu7fV97dw4eoB2Nled3UOSpsRXFAacsccpclx+/Gyk62eRJkMrMMZsA52Nxl4A+JkCR56h7TcQXpaLpp2Kml9cDpvsQfghwfT3lDvfIIZc+d4gvStDdKolcqflSFWeORxxTAbH+mCNIgep6jlorVM91D1m6kT2uabM5Gg6z2AKRGPbHyHeJ9E94XgN+O0SyXBie9nOp9mrWEIMulc5pFOCYVWRM1juxEeQwCYUlXB4VRYpWTbQ6XVFbMg+XQNw3pdLGSgiKSx8JgBuS98T0bDBcYoS9+dX75OpgLiOzhTwBruejCMbNLxQyAlSNDtwjh1zdwhM/vcFGzvmWSFEw6lwWsSgWzOKcsgS9wa9eBvqScKZIHPoO6H+bgzLi/1wkEsuXhP3yZNojT9aEzbHfjjwmnUUH3H6PVf8tliq4th3I1Y/pz/Mk2G/ZxvthCW3wA7aQMlDatplDAAAAAElFTkSuQmCC","ic_attack":"data:image/png;base64,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","ic_recovery":"data:image/png;base64,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","ic_sit":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAHd0lEQVR4nMVXLXjjSBJ9mS+gxaRDEnNDZZHEbBZDzyFn0STIHpQs8wQ5i5KgTdgmaBwUB02MZsRGQSejk9FZbNpMYmp0anb7VUn22NlZcOSuE1uS+6eqXr360R6A/+D/OPbp69/fPm9+MJUBDADxeqnZufCtMfWjMaiq7bX0YO08b7Y1N3Ec4fz+pVbAVMDffvr7f629vaXPll48xA9+2x6/jw75uk9fjuPxQ0sAujmYrwKgGa0B2bIRrzRcWyCUNqJFAdsWGzvJxkIDgvYIgdKY+oo1ogJaG9aMLmuE3mzrbwnBQtceoAOEEHj8fIkv6iu+frrk3cbUypELWLj5/ptNe7Y8aDV3JHyt3PZ48xoaRwj+8DJjcNTvwnEc3Ax/QefoGKHvIs0KnndsUrC2zlmfa2pBfIaolaPFLNyukWEXib9QwDSW0GJaJSwgiRMcj0aYXl1gMOrjbNBjmLLC8MdpMKM/QrFBfGPQazKIre/97QnpCWYzQUv71MogzRR6vTbyQrFyWbJAv9+DIyoI6cN1HJy/vwaEQShdUFzQGZYFqNxA2gJGk+fMxq3r83cUoOeKQpDsYAoLyBbwEGU4aLnsSyJdrgyuz6/x8Z9fYVkd3vt2eIW9vT1UqoDn2s1ZYMLano3AMYDSO8isEXiz/ehYdWBZdOV5ASmAm4cXuC0H8cucGSyly2vSL1e4OjpAvpzg27fPWBHhKWSIfE14qFwjL02tzNo9P+KAYNFbCDSHuK4N6QqcnFzjPsqAssT4cQKVzjGPYt7x4edfIPIVvv3rExa6DjDmg0VGfVeGxjoKDAc7dklIsDlWs8AYKKV5s+cI5BTjAG6eJzC6QjKLUGqDJFVsThwnzKGvj2OCoTGmditZTjqsFWEEmof9nQgAkJeahfe6AWzXw9NDhNKutb08PUSuFOJZxEKVUryO7m3Pg1IFusdDpMmC93nsqpqAlJwpsvLKgGyk/LKjgEMLLAFjgYnmSQ9n41N0e5QyDcK3PeRphlJrJtZsGkFKD2EYIE0zdgeNUuU4uxhhRoqTMQDavotCG+RKw/NsFMX3BLW/4QCHax1Cvu8iiRIs0yU6nZAVUFkG4dh4un3aMGgWLRDHGc5GfWjtIEtSdG8uYDk+eoMe7u4jdBrh0iMTgUxpzjPrVPlmOzuwrxrIyDqjDe7uZkiSJaJZgusP9+j2ezgbHWM0HuLj4yUsR+DX8ye4ngs/9BE9TQkH9HqH60CCKQ3iVPH57cBtasGrMKRBgslZnIyoZGYFOp2AM7rKVhjfjDC8uoIRAne3E3iehy/Lf2D82ylm0xlmdw/I0gzAAcK3Qxy0yJ11WJDwTBUbBH6YiisSzvkASJcKjmuj3fbhOALSd/F2+A7plym6R0OO79tfbxFP7tA/7mGSLHHx6REXk4Sinz+DDyNQ5FMoF4Vm4hH3zZ+rIZihRZNECP6XlcHwqMuaZipngVSQeHOV4+zDAGmSIc81ZpMHxNNruFKizGMkz1OoNEPnsI1O10dRGM6iFOKCQrquT7skLLVB22+xG/K8hCuAwHdxN5mxDy1L4PZhDt+XqHRAZY59GUcJ/0Z8SWYnCLptHLQ7UNkCtu3C932UZQpUhAWlHwGHovq1CzQVGlWX2WRRYPjuEEmyYB/ajkBLejy3KjRUumggBaM2XxASOYTtIksVyrxkuI3RyDLFa8m1xANCLJDuxu379aWp4U7dgMiWwOjiDCfdE8775BLOBYGNq9sIh4dtzu2ObfOV3JMpyph19tOrjPM/oUP7aL9kjlXQJSlRbEr0fiOffetLj8nnhwEW8ZxQZqjICjqk7ftQao6HhwiDQQ+lfoJ/4CMMfNw9vGCBAqUhAuewCG5HcKSQUYRQkRv4oYQibbHjgootoVilcdQN8Dx9bmq4BUGdTFnyc+C3kKaLTUdcVhXH/3j8DoN3h+i1W9BaoywM/KCD/qDPa8NOiJa02VJyRR1vqBGgW9McTnPPzxFPtoNWDRAdEISoTIlFssJwNIDfbePyZoT3728R+hn8AwkpQ3S6IYwuIWwPQa+N+SxiUsuWi95RDzovMFPRpkna3w5DGpw2G8KR4LwsEQQ+1Cpn5U4vTtE57GAevTD0lGqfZ3PopxcEQYsRszyiuUIUxej2OhjfXEBlSyySxaYINckAm/cCKjAEnd10NKQ1MbzletAFkUxhfDlClmW4vb7lA6b5lJU66re51kbPCYSl0Q0lqrKEUjniWV2kPLfmAsuw7U253l8jQApRxlpDToOEU2SwewKJyfUdk5KIZbsu9SbwfZs7XyJWuyN5riwrbk7DMGT+kOCsCVUpJSv2ioSG49NqmgTa4DgWC69TdIVup83tMvX3hI7KuKbWLxtkoefVqNJez0FORCzrfFCoojHK4l5AyroyboWhgeMA2VLBpp6AXz4oN9TtGVU8la8Qhge8nPxJqZW75EwxOtlCcQ9BWbPUJRNRVSU8UqbIWWkiINUZamTWY4/ejj9/pDbqh807D24e+L++1tPr3tH63vOtX2jWbt09cTPIZVm6xM/n97UCf7HufzL+AH46zEt2OpEYAAAAAElFTkSuQmCC","ic_autoget":"data:image/png;base64,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"};
const LEAN_CSS = ":host{position:fixed;right:18px;top:90px;width:450px;z-index:2147483646;font:12px/1.3 Arial,Helvetica,sans-serif;color:#efdaa4;color-scheme:dark;text-shadow:1px 1px #000}\n*{box-sizing:border-box} [hidden]{display:none!important}\n.panel{position:relative;padding-bottom:19px;background:rgba(15,19,17,.96);box-shadow:0 8px 28px #000a}\n.panel:before{content:'';position:absolute;inset:36px 14px 16px;background-image:var(--s-tile_a);opacity:.55;pointer-events:none}\n.frame{position:absolute;pointer-events:none;background-repeat:no-repeat}\n.frame.lu{left:0;top:0;width:40px;height:68px;background-image:var(--s-f_lu)}\n.frame.mu{left:40px;right:40px;top:0;height:68px;background-image:var(--s-f_mu);background-repeat:repeat-x}\n.frame.ru{right:0;top:0;width:40px;height:68px;background-image:var(--s-f_ru)}\n.frame.ls{left:0;top:68px;bottom:48px;width:40px;background-image:var(--s-f_ls);background-repeat:repeat-y}\n.frame.rs{right:0;top:68px;bottom:48px;width:40px;background-image:var(--s-f_rs);background-repeat:repeat-y}\n.frame.ld{left:0;bottom:0;width:40px;height:48px;background-image:var(--s-f_ld)}\n.frame.md{left:40px;right:40px;bottom:0;height:48px;background-image:var(--s-f_md);background-repeat:repeat-x}\n.frame.rd{right:0;bottom:0;width:40px;height:48px;background-image:var(--s-f_rd)}\nheader{position:relative;z-index:1;height:34px;display:flex;align-items:center;justify-content:center;cursor:move;touch-action:none;padding:6px 32px 0;color:#fff}\n\nheader strong{font-weight:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\nheader button.fold{position:absolute;right:10px;top:10px;width:16px;min-width:16px;height:16px;padding:0;border:0;background:var(--s-close);color:transparent;font-size:0}\nheader button.fold:hover{background-image:var(--s-close_f)}\n.body{position:relative;z-index:1;margin:0 15px}\nbutton,input,select{font:12px Arial,Helvetica,sans-serif;color:inherit;text-shadow:inherit;border-radius:0}\nbutton{display:inline-flex;align-items:center;justify-content:center;min-width:52px;height:24px;padding:0 6px;cursor:pointer;white-space:nowrap;background:transparent;color:#fefbd8;border-style:solid;border-width:5px;border-image-source:var(--s-btn);border-image-slice:6 fill;border-image-width:5px;border-image-repeat:stretch;line-height:14px}\nbutton:hover{border-image-source:var(--s-btn_f);color:#fff}button:active{border-image-source:var(--s-btn_p)}button:disabled{border-image-source:var(--s-btn_d);color:#7c786c;cursor:default}\nbutton:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid #ffe08a;outline-offset:1px}\nnav,.row,.subtabs{display:flex;align-items:center;gap:5px;flex-wrap:wrap}\nnav{padding-top:4px;gap:2px}nav button{flex:1;padding:0 5px;font-size:11px}.subtabs{margin:0 0 8px;gap:2px}\nnav button,.subtabs button{height:24px;min-width:56px;padding:0 8px;color:#d8d4c4;border-width:0 6px;border-image-source:var(--s-tab_off);border-image-slice:0 8 fill;border-image-width:0 6px;line-height:23px}\nnav button[aria-selected=true],.subtabs button[aria-selected=true]{color:#fff;border-image-source:var(--s-tab_on)}\n.subtabs button{font-size:11px;min-width:48px;border-image-source:var(--s-stab_off)}\n.subtabs button[aria-selected=true]{border-image-source:var(--s-stab_on)}\n.class-tabs{display:flex;gap:3px;flex-wrap:wrap;margin-bottom:7px}.class-tabs button{font-size:11px;gap:4px;text-transform:capitalize;flex:1;min-width:80px}.class-tabs button[aria-selected=true]{color:#ffe08a}.class-tabs i{display:inline-block;width:16px;height:16px;flex:0 0 16px;background-size:16px 16px}\n.pane,.dialog-body{padding-top:9px;max-height:clamp(220px,calc(100vh - 300px),720px);overflow:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-color:#796a48 #171711}\n.pane::-webkit-scrollbar,.dialog-body::-webkit-scrollbar{width:16px}.pane::-webkit-scrollbar-track,.dialog-body::-webkit-scrollbar-track{background-image:var(--s-scr_bar)}.pane::-webkit-scrollbar-thumb,.dialog-body::-webkit-scrollbar-thumb{background:var(--s-scr_btn) center/16px 100% no-repeat;min-height:16px}.pane::-webkit-scrollbar-thumb:hover,.dialog-body::-webkit-scrollbar-thumb:hover{background-image:var(--s-scr_btn_f)}\nfieldset{position:relative;min-width:0;border:0;margin:0 0 9px;padding:25px 10px 9px;background-color:#282728;background-image:var(--s-ib_lu),var(--s-ib_ru),var(--s-ib_ld),var(--s-ib_rd),var(--s-ib_mu),var(--s-ib_md),var(--s-ib_ls),var(--s-ib_rs);background-position:left top,right top,left bottom,right bottom,left top,left bottom,left top,right top;background-repeat:no-repeat,no-repeat,no-repeat,no-repeat,repeat-x,repeat-x,repeat-y,repeat-y}\nlegend{position:absolute;left:9px;right:9px;top:3px;padding:0;height:13px;line-height:13px;color:#ffd65a;font-weight:bold}\n.field{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;min-height:18px}.field>span{flex:1}\ninput:not([type=checkbox]),select{height:22px;background:#080907;border:1px solid #5d5034;padding:0 4px;outline:none;min-width:0;color:#efdaa4}\ninput:focus,select:focus{border-color:#c9a85c}.field input[type=number]{width:66px;text-align:right}.field input[type=text]{width:170px}.field select{max-width:220px;min-width:110px}\ninput[type=checkbox]{appearance:none;width:16px;height:16px;flex:0 0 16px;margin:0;border:0;background:var(--s-chk_off) center/16px 16px;cursor:pointer}input[type=checkbox]:checked{background-image:var(--s-chk_on)}\n.status{padding:6px 6px 8px;white-space:pre-line;color:#f4eedc;border-bottom:1px solid #5d503455}\n.controls{padding:6px 0;gap:3px}.controls button:first-child{flex:1}\n.feedback{padding:6px 4px 0;overflow-wrap:anywhere;font-size:11px;min-height:8px}\n.muted{color:#a09b8c;font-size:11px;margin:6px 0}\n.grid{display:flex;flex-wrap:wrap;gap:5px;align-content:flex-start;margin:8px 0}\nbutton.slot,.skill-icon{position:relative;display:inline-block;flex:0 0 34px;width:34px;min-width:34px;height:34px;border:1px solid #4e4532;border-image:none;background:#050505;box-shadow:inset 0 0 0 1px #17140e;padding:0;overflow:hidden;vertical-align:middle}\nbutton.slot:hover{border-image:none;border-color:#d9b765}.slot.on{border-color:#ffe08a;box-shadow:0 0 5px 1px #ffd678a6}\n.slot img,.skill-icon img{position:absolute;inset:0;width:32px;height:32px;image-rendering:auto}\n.fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#b1a17b}.slot[data-icon-loaded=true]>.fallback,.skill-icon[data-icon-loaded=true]>.fallback{display:none}\n.slot .cd{position:absolute;inset:0;background:conic-gradient(#000b var(--p,0%),transparent 0);pointer-events:none}\n.slot .seconds{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:11px;pointer-events:none}\n.slot .order{position:absolute;left:1px;top:0;color:#ffd65a;font-size:10px;line-height:11px;pointer-events:none}\n.skill-row{display:flex;align-items:center;gap:7px;min-height:42px;padding:4px 5px;margin:3px 0;background-image:var(--s-bar_l),var(--s-bar_r),var(--s-bar);background-position:left,right,center;background-repeat:no-repeat,no-repeat,repeat-x;background-size:4px 100%,4px 100%,auto 100%}\n.skill-row:hover{background-image:var(--s-bars_l),var(--s-bars_r),var(--s-bars)}\n.skill-row .skill-info{flex:1;min-width:0}.skill-name{display:block;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.skill-detail{font-size:10px;color:#d6c794}.skill-row button.mini{min-width:22px;width:22px;padding:0;height:22px}\n.picker-title{display:flex;align-items:center;gap:6px;justify-content:space-between;margin-top:8px}.picker-title input{max-width:170px;width:50%;font-size:11px}\n.skill-tip{position:fixed;z-index:2147483647;max-width:270px;pointer-events:none;padding:9px;background:rgba(8,9,6,.97);border:1px solid #b79b5c;box-shadow:inset 0 0 0 2px #30291c,0 3px 10px #000;font-size:12px;color:#efdaa4;white-space:pre-line;text-shadow:1px 1px #000}\n.skill-tip strong{display:block;color:#fff;margin-bottom:5px}.empty{padding:10px 4px;color:#a09b8c;text-align:center}\npre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;max-height:130px;overflow:auto;overscroll-behavior:contain;margin:5px 0}\n.wardrobe-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin-bottom:8px}\n.wardrobe-item{min-width:0;height:48px;padding:4px;justify-content:flex-start;gap:6px;text-align:left;font-size:10px;white-space:normal;line-height:12px}\n.wardrobe-item>.slot{flex:0 0 34px}.wardrobe-item>span:last-child{overflow:hidden;max-height:36px;overflow-wrap:anywhere}\n.wardrobe-item[aria-pressed=true]{color:#ffe08a;outline:1px solid #ffe08a;outline-offset:-2px}\n@media(max-width:500px){:host{right:4px;top:70px;width:calc(100vw - 8px)}.body{margin:0 13px}.pane{max-height:clamp(200px,calc(100vh - 280px),720px)}.field input[type=text]{width:150px}.skill-row{gap:4px}.controls{gap:2px}}\n\n.waiting{white-space:pre-line;color:#c8d9ae;margin:4px 0}\ntextarea{width:100%;color:inherit;background:#151916;font:11px monospace}\n\n.dialog{position:fixed;width:min(430px,calc(100vw - 8px));z-index:2147483646}.dialog[hidden]{display:none}.dialog-body{max-height:min(70vh,640px);margin:0 15px}\n";

function assetLoaderMain(self) {
  'use strict';
  const OWN_CACHE = 'sro-lean-icons-v1';
  const GAME_CACHE = 'sro-next-verified-v1';
  const GAME_PACK_MAX = 4 << 20; // the game caches whole packs up to this size
  const NET_SLOTS = 6;
  const OWN_CACHE_MAX = 6000; // entries; the oldest half is dropped above this
  let ORIGIN = '';
  let manifestP = null;
  let manifestAt = 0;
  let manifestGen = 0; // bumped on every successful manifest load
  let forcedAt = 0;
  let refreshing = null;
  let manifestInfo = null;
  const heads = new Map(); // packPath -> Promise<data start offset>
  const caches_ = new Map(); // name -> Promise<Cache|null>
  let skillRows = null;
  const stats = {
    requests: 0,
    ok: 0,
    fail: 0,
    ownCache: 0,
    gameCache: 0,
    gamePack: 0,
    transport: 0,
    range: 0,
    retries: 0,
    manifestLoads: 0,
    bytes: 0,
    lastError: '',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fail(code, message, status) {
    const e = new Error(message);
    e.code = code;
    if (status) e.status = status;
    return e;
  }

  // ---- network ----------------------------------------------------------

  const slots = { n: 0, q: [] };
  async function withSlot(fn) {
    while (slots.n >= NET_SLOTS) await new Promise((r) => slots.q.push(r));
    slots.n++;
    try {
      return await fn();
    } finally {
      slots.n--;
      const next = slots.q.shift();
      if (next) next();
    }
  }

  async function fetchBytes(url, opt) {
    opt = opt || {};
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opt.timeout || 30000);
    try {
      const init = { cache: opt.cache || 'no-cache', credentials: 'same-origin', signal: ctl.signal };
      if (opt.range) init.headers = { Range: 'bytes=' + opt.range[0] + '-' + opt.range[1] };
      const res = await fetch(ORIGIN + url, init);
      if (!(res.ok || res.status === 206)) throw fail('http', url + ' HTTP ' + res.status, res.status);
      let bytes = new Uint8Array(await res.arrayBuffer());
      if (opt.range) {
        if (res.status !== 206) bytes = bytes.subarray(opt.range[0], opt.range[1] + 1);
        if (bytes.length !== opt.range[1] - opt.range[0] + 1) throw fail('format', url + ': short response (' + bytes.length + ' bytes)');
      }
      stats.bytes += bytes.length;
      return bytes;
    } catch (e) {
      if (e && e.code) throw e;
      if (ctl.signal.aborted) throw fail('timeout', 'timeout: ' + url);
      throw fail('network', 'network error: ' + url + ' (' + ((e && e.message) || e) + ')');
    } finally {
      clearTimeout(timer);
    }
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream !== 'function') throw fail('format', 'the browser cannot decompress gzip (DecompressionStream missing)');
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      throw fail('format', 'gzip could not be decompressed: ' + ((e && e.message) || e));
    }
  }

  async function sha256(bytes) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let s = '';
    for (const b of d) s += b.toString(16).padStart(2, '0');
    return s;
  }

  // ---- Cache Storage ----------------------------------------------------

  function openCache(name) {
    if (!caches_.has(name)) {
      caches_.set(
        name,
        Promise.resolve()
          .then(() => (typeof caches === 'undefined' ? null : name === GAME_CACHE ? caches.has(name).then((ok) => (ok ? caches.open(name) : null)) : caches.open(name)))
          .catch(() => null)
      );
    }
    return caches_.get(name);
  }

  async function cacheGet(name, key) {
    try {
      const c = await openCache(name);
      if (!c) return null;
      const r = await c.match(key);
      return r ? new Uint8Array(await r.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }

  let ownPuts = 0;
  function putOwn(sha, bytes) {
    openCache(OWN_CACHE)
      .then((c) => c && c.put(ORIGIN + '/__sro_asistan__/' + sha, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })))
      .catch(() => {});
    if (++ownPuts === 50) setTimeout(pruneOwn, 20000);
  }

  async function pruneOwn() {
    try {
      const c = await openCache(OWN_CACHE);
      if (!c) return;
      const keys = await c.keys();
      if (keys.length <= OWN_CACHE_MAX) return;
      for (const k of keys.slice(0, keys.length - OWN_CACHE_MAX / 2)) await c.delete(k);
    } catch {}
  }

  // ---- manifest ---------------------------------------------------------

  function manifest(force) {
    if (force || !manifestP) {
      const p = (async () => {
        let last = null;
        for (let i = 0; i < 3; i++) {
          try {
            const bytes = await fetchBytes('/assets/packs/manifest.json', { timeout: 90000 });
            let data;
            try {
              data = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
              throw fail('format', 'manifest JSON could not be read');
            }
            if (!data || !Array.isArray(data.assets)) throw fail('format', 'manifest format not recognised (' + ((data && data.format) || '?') + ')');
            const assets = new Map();
            for (const a of data.assets) if (a && a.path && a.packPath) assets.set(String(a.path).toLowerCase(), a);
            const packs = new Map();
            for (const g of data.groups || []) for (const pk of (g && g.packs) || []) if (pk && pk.path) packs.set(pk.path, pk);
            stats.manifestLoads++;
            manifestGen++;
            manifestAt = Date.now();
            manifestInfo = {
              format: data.format || '',
              generatedAt: data.generatedAt || '',
              deliveryVersion: data.deliveryVersion == null ? '' : String(data.deliveryVersion),
              assets: assets.size,
              packs: packs.size,
            };
            return { assets, packs };
          } catch (e) {
            last = e;
            if (i < 2) await sleep(1500 * (i + 1));
          }
        }
        if (last) last.manifest = true;
        throw last;
      })();
      manifestP = p;
      p.catch(() => {
        if (manifestP === p) manifestP = null;
      });
    }
    return manifestP;
  }

  // Re-read the manifest after a sign that the packs were republished. Concurrent
  // failures share one download, and a forced re-read happens at most every 30 s.
  function refreshManifest(seenGen) {
    if (refreshing) return refreshing;
    if (manifestGen > seenGen || Date.now() - forcedAt < 30000) return manifest();
    forcedAt = Date.now();
    const p = manifest(true);
    refreshing = p;
    const done = () => {
      if (refreshing === p) refreshing = null;
    };
    p.then(done, done);
    return p;
  }

  function packStart(packPath) {
    if (!heads.has(packPath)) {
      const p = fetchBytes(packPath, { range: [0, 11], timeout: 30000 }).then((h) => {
        let magic = '';
        for (let i = 0; i < 8; i++) magic += String.fromCharCode(h[i]);
        if (magic !== 'SROPACK1') throw fail('format', 'bad pack identifier: ' + packPath);
        const len = new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(8, true);
        if (len > 16 << 20) throw fail('format', 'bad pack header: ' + packPath);
        return 12 + len;
      });
      p.catch(() => heads.delete(packPath));
      heads.set(packPath, p);
    }
    return heads.get(packPath);
  }

  // ---- one asset --------------------------------------------------------

  async function fromCaches(m, asset) {
    const own = await cacheGet(OWN_CACHE, ORIGIN + '/__sro_asistan__/' + asset.sha256);
    if (own && own.length === asset.length && (await sha256(own)) === asset.sha256) {
      stats.ownCache++;
      return own;
    }
    const game = await cacheGet(GAME_CACHE, ORIGIN + '/assets/.verified/' + asset.sha256);
    if (game && game.length === asset.length && (await sha256(game)) === asset.sha256) {
      stats.gameCache++;
      return game;
    }
    const pk = m.packs.get(asset.packPath);
    if (pk && pk.sha256 && pk.bytes <= GAME_PACK_MAX) {
      const pack = await cacheGet(GAME_CACHE, ORIGIN + '/assets/.verified/' + pk.sha256);
      if (pack && pack.length >= 12) {
        const len = new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(8, true);
        const start = 12 + len + asset.offset;
        if (start + asset.length <= pack.length) {
          const b = pack.slice(start, start + asset.length);
          if ((await sha256(b)) === asset.sha256) {
            stats.gamePack++;
            return b;
          }
        }
      }
    }
    return null;
  }

  async function fromNetwork(asset) {
    if (asset.transport && asset.transport.path) {
      try {
        const gz = await fetchBytes(asset.transport.path, { timeout: 60000, cache: 'default' });
        if (asset.transport.sha256 && (await sha256(gz)) !== asset.transport.sha256) throw fail('checksum', 'transport file SHA-256 mismatch: ' + asset.path);
        const raw = await gunzip(gz);
        stats.transport++;
        return raw;
      } catch (e) {
        // The transport copy is an optimisation; the pack still has the bytes.
        if (!asset.packPath) throw e;
      }
    }
    const start = (await packStart(asset.packPath)) + asset.offset;
    const raw = await fetchBytes(asset.packPath, { range: [start, start + asset.length - 1], timeout: 45000 });
    stats.range++;
    return raw;
  }

  // tries: {refreshed, waits}: one manifest re-read and up to 3 backoff waits per request.
  async function bytesOf(path, tries) {
    const t = tries || { refreshed: false, waits: 0 };
    if (!tries) stats.requests++;
    let retry = ''; // 'manifest': re-read the manifest first; 'wait': back off
    let error = null;
    let gen = manifestGen;
    try {
      const m = await manifest();
      gen = manifestGen;
      const key = String(path).toLowerCase();
      let asset = m.assets.get(key);
      let gz = false;
      if (!asset && key.endsWith('.json')) {
        asset = m.assets.get(key + '.gz');
        gz = !!asset;
      }
      if (asset) {
        let raw = await fromCaches(m, asset);
        if (!raw) {
          raw = await withSlot(() => fromNetwork(asset));
          if (raw.length !== asset.length) throw fail('format', 'uzunluk tutmuyor: ' + path);
          if ((await sha256(raw)) !== asset.sha256) throw fail('checksum', 'SHA-256 tutmuyor: ' + path);
          putOwn(asset.sha256, raw);
        }
        if (gz || /\.gz$/i.test(asset.path)) raw = await gunzip(raw);
        stats.ok++;
        return { bytes: raw, mime: asset.mime || '' };
      }
      // Possibly a file added by a later deploy: re-read an older manifest once.
      if (!t.refreshed && Date.now() - manifestAt > 120000) retry = 'manifest';
      else throw fail('missing', 'not found in the game packs: ' + path);
    } catch (e) {
      error = e;
      const code = e && e.code;
      const status = e && e.status;
      const stale = code === 'checksum' || code === 'format' || (code === 'http' && (status === 404 || status === 410 || status === 416));
      const transient = code === 'timeout' || code === 'network' || (code === 'http' && status >= 500) || !code;
      if (e && e.manifest) retry = ''; // the manifest download has its own retries
      else if (stale && !t.refreshed) retry = 'manifest';
      else if ((transient || stale) && t.waits < 3) retry = 'wait';
    }
    if (retry) {
      stats.retries++;
      if (retry === 'manifest') {
        t.refreshed = true;
        await refreshManifest(gen).catch(() => {});
      } else {
        await sleep(700 * 2 ** t.waits);
        t.waits++;
      }
      return bytesOf(path, t);
    }
    stats.fail++;
    stats.lastError = String((error && error.message) || error);
    throw error;
  }

  self.onmessage = async e => {
    const msg = e.data || {};
    if (msg.op === 'init') { ORIGIN = String(msg.origin || ''); self.postMessage({ ready: true }); return; }
    try {
      const allowed = ['/assets/data/levelData.json', '/assets/data/cosPresentation.json', '/assets/data/skillData.json', '/assets/text/textdataname.en.json', '/assets/data/missionPresentation.json', '/assets/char/roster.json', '/assets/npc/manifest.json'];
      if (msg.op !== 'blob' && !(msg.op === 'json' && allowed.includes(msg.path))) throw fail('op', 'Unsupported asset request');
      const { bytes, mime } = await bytesOf(msg.path);
      const result = msg.op === 'json' ? JSON.parse(new TextDecoder().decode(bytes)) : new Blob([bytes], { type: mime || 'image/png' });
      self.postMessage({ id: msg.id, ok: true, result });
    } catch (e) { self.postMessage({ id: msg.id, ok: false, error: e.message, code: e.code }); }
  };
}

// Lazy, shared image cache using the game's verified packs. No catalogue downloads.
const Icons = {
  port: null, ready: null, forcePage: false, seq: 0,
  pending: new Map(), urls: new Map(), failures: new Map(),
  iconPath(ddj) {
    if (!ddj) return '';
    let path = String(ddj).replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '').replace(/^icon\//, '').replace(/\.ddj$/, '.png');
    if (!path.endsWith('.png') || path.split('/').includes('..') || !/^[a-z0-9_./ -]+$/.test(path)) return '';
    return '/assets/images/Media_extracted/icon/' + path;
  },
  boot() {
    if (this.ready) return this.ready;
    this.ready = new Promise(resolve => {
      let worker = null, url = '', timer = 0, settled = false;
      const finish = port => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.port = port;
        port.post({ op: 'init', origin: W.location.origin });
        resolve(port);
      };
      const page = () => {
        if (settled) return;
        if (worker) worker.terminate();
        if (url) URL.revokeObjectURL(url);
        const host = { postMessage: result => this.reply(result) };
        assetLoaderMain(host);
        finish({ post: msg => host.onmessage({ data: msg }) });
      };
      if (this.forcePage) { page(); return; }
      try {
        url = URL.createObjectURL(new Blob(['(' + assetLoaderMain.toString() + ')(self)'], { type: 'text/javascript' }));
        worker = new (Hook.NativeWorker || W.Worker)(url, { name: 'sro-lean-icons' });
        const port = { post: msg => worker.postMessage(msg) };
        worker.onmessage = e => {
          if (e.data?.ready) { if (!settled) { URL.revokeObjectURL(url); finish(port); } }
          else this.reply(e.data);
        };
        worker.onerror = e => {
          e.preventDefault();
          if (!settled) { page(); return; }
          worker.terminate(); this.forcePage = true; this.ready = null; this.port = null;
          for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Icon worker stopped')); this.pending.delete(id); }
        };
        timer = setTimeout(page, 8000);
        port.post({ op: 'init', origin: W.location.origin });
      } catch { page(); }
    });
    return this.ready;
  },
  reply(result) {
    if (!result?.id) return;
    const pending = this.pending.get(result.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(result.id);
    result.ok ? pending.resolve(result.result) : pending.reject(new Error(result.error || 'Icon unavailable'));
  },
  async request(path, op = 'blob') {
    const port = await this.boot();
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Icon request timed out')); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      port.post({ id, op, path });
    });
  },
  url(path) {
    if (!path) return Promise.resolve('');
    if (this.urls.has(path)) return this.urls.get(path);
    if ((this.failures.get(path) || 0) > now()) return Promise.resolve('');
    const result = this.request(path).then(blob => { this.failures.delete(path); return URL.createObjectURL(blob); }, error => {
      this.urls.delete(path); this.failures.set(path, now() + 30000);
      Log.warn('Skill icon unavailable: ' + path + ' (' + error.message + ')');
      return '';
    });
    this.urls.set(path, result);
    return result;
  },
  paint(node, icon, attempt = 0) {
    const path = this.iconPath(icon);
    node.dataset.iconPath = path;
    if (!path) return;
    this.url(path).then(url => {
      if (node.dataset.iconPath !== path || !node.isConnected) return;
      if (url) {
        const image = document.createElement('img'); image.alt = ''; image.draggable = false;
        image.src = url; image.addEventListener('load', () => { node.dataset.iconLoaded = 'true'; });
        node.prepend(image);
      } else if (attempt < 2) setTimeout(() => { if (node.isConnected) this.paint(node, icon, attempt + 1); }, 31000);
    });
  },
};


// Repair missing learned metadata lazily; never add an unlearned skill to the character.
const Learned = {
  pending: null, retryAt: 0,
  rows() {
    return (World.gp?.skills || []).map(id => World.skill(id) || { id, group: id, name: 'Skill #' + id, missing: true });
  },
  async repair() {
    const needsRepair = this.rows().some(s => s.missing || !s.name || s.name === 'Skill #' + s.id || /^(?:SN_)?SKILL_/i.test(s.name));
    if (this.pending || now() < this.retryAt || !needsRepair) return;
    this.retryAt = now() + 30000;
    this.pending = (async () => {
      const [data, names] = await Promise.all([Icons.request('/assets/data/skillData.json', 'json'), Icons.request('/assets/text/textdataname.en.json', 'json')]);
      const learned = new Set(World.gp?.skills || []), additions = [];
      for (const row of data.rows || []) {
        const m = row.split('\t'), id = Number(m[0]);
        if (!learned.has(id)) continue;
        const current = World.skill(id);
        const symbolicName = /^(?:SN_)?SKILL_/i.test(current?.name || '');
        if (current?.name && !symbolicName && !current.missing) continue;
        // These are the projected columns published by buildSkillDataAsset.mjs.
        const group = Number(m[1]), sibling = World.groups.get(group)?.[0];
        const nameKey = current?.nameSymbol || (symbolicName ? current.name : m[19]);
        additions.push({ ...current, id, group: current?.group ?? group, level: current?.level ?? Number(m[2]), active: current?.active ?? Number(m[3]) !== 0,
          name: names.entries?.[nameKey] || names.entries?.[m[19]] || (symbolicName ? 'Skill #' + id : current?.name) || 'Skill #' + id,
          nameSymbol: current?.nameSymbol || m[19], icon: current?.icon || m[18], mp: current?.mp ?? (Number(m[24]) || 0),
          targetRequired: current?.targetRequired ?? (m[78] === undefined ? !!sibling?.targetRequired : Number(m[78]) !== 0),
          cooldownMs: current?.cooldownMs ?? sibling?.cooldownMs ?? 0 });
      }
      if (additions.length) {
        const merged = new Map(World.catalog);
        for (const row of additions) merged.set(row.id, { ...merged.get(row.id), ...row });
        World.rebuildCatalog([...merged.values()]);
      }
    })().catch(e => Log.warn('Learned skill metadata: ' + e.message)).finally(() => { this.pending = null; });
    return this.pending;
  },
};


const WD_MEDIA = '/assets/images/Media_extracted/';
// Socket art keys (interface/equipment/equip_slot_<key>.png) per equipment slot 0..8
// and per avatar slot 0..3 (hat, dress, attachment, flag).
const WD_EQ_KEYS = ['helm', 'mail', 'shoulderguard', 'gauntlet', 'pants', 'boots', 'weapon', 'shield', 'specialdress'];
const WD_AV_KEYS = ['helm', 'cloth', 'pandernt', 'plag'];
// Socket grid: left column head/chest/legs, middle shoulder/hands/feet (the game's
// equipment pane), right column weapon/shield/job suit.
const WD_EQ_GRID = [0, 2, 6, 1, 3, 7, 4, 5, 8];
const WD_PAGE = 66;

// Codename grammar of every armour, weapon and shield in roster.dress (8439 rows, all
// slot 0..7 rows match except the two fortress weapons): race, sex, class, degree,
// part (HA/CA head, SA shoulder, BA chest, LA legs, AA hands, FA feet), grade, suffix.
const WD_RX = /^ITEM_(CH|EU)_(?:([MW])_(CLOTHES|LIGHT|HEAVY)_(\d\d)_(HA|CA|SA|BA|LA|AA|FA)|(SWORD|BLADE|SPEAR|TBLADE|BOW|DAGGER|TSWORD|AXE|CROSSBOW|DARKSTAFF|TSTAFF|HARP|STAFF|SHIELD)_(\d\d))_([ABC])(?:_(DEF|SUPER|RARE|MAGIC|LEGEND|MYTH)(?:_HONOR)?)?$/;
// Weapon tid4 per kind (client tooltip table Zp L5916 and stance table wh L17764).
const WD_WEAPON_T4 = { SWORD: 2, BLADE: 3, SPEAR: 4, TBLADE: 5, BOW: 6, EUSWORD: 7, TSWORD: 8, AXE: 9, DARKSTAFF: 10, TSTAFF: 11, CROSSBOW: 12, DAGGER: 13, HARP: 14, STAFF: 15, FORT: 16 };
const WD_ARMOR_T3 = { CLOTHES: 1, LIGHT: 2, HEAVY: 3 }; // +8 for European armour
const WD_JOB_T4 = { TRADER: 1, THIEF: 2, HUNTER: 3, VOUCHER: 5 };
// Equipment slot -> armour tid4 (inverse of the client rule [0,2,1,4,3,5][tid4-1]).
const WD_SLOT_T4 = [1, 3, 2, 5, 4, 6];
// Weapons a shield is worn with (random outfits keep two-handed weapons shield-free).
const WD_ONE_HAND = new Set(['SWORD', 'BLADE', 'EUSWORD', 'DAGGER', 'DARKSTAFF', 'STAFF']);
// Pick-pet models drawn exactly like another family (cos models get no material
// variant, R7 glow_pets), left out of the list.
const WD_PET_SKIP = new Set(['COS_P_PINKPIG', 'COS_P_SPOT_RABBIT']);

const WdCfg = () => Settings.profile.wardrobe;
const wdInt = (v, lo, hi) => clamp(Math.trunc(Number(v) || 0), lo, hi);
const wdTid3 = (tf) => ((Number(tf) >>> 0) >>> 7) & 15;
const wdTid4 = (tf) => ((Number(tf) >>> 0) >>> 11) & 31;
// Equipment typeFlags: bits 2-3 equipment (12), bit 5 wearable (32), tid3, tid4.
const wdTf = (t4, t3) => ((t4 << 11) | (t3 << 7) | 32 | 12) >>> 0;
const wdIsEquip = (tf) => ((Number(tf) >>> 0) & 126) === 44;
// Skill clip family of a weapon typeFlags: the game plays `${role}-${family}` (As(),
// index L21568) and skips the cast when neither that clip nor the bare role exists.
const WD_ANIM_FAM = { 2: 'sword', 3: 'sword', 4: 'spear', 5: 'spear', 6: 'bow', 12: 'bow', 7: '1hsword', 8: '2hsword', 9: 'axe', 10: '1hstaff', 15: '1hstaff', 11: '2hstaff', 13: 'dagger', 14: 'harp' };
const wdAnimFam = (tf) => WD_ANIM_FAM[wdTid4(tf)] || '';
// Job mode the game derives from inventory slot 8 (ac(), index L4334): 1..3 trader /
// thief / hunter, anything else normal; party matching and its commands follow it.
const wdJobMode = (tf) => ((Number(tf) >>> 0) & 2046) === 940 && wdTid4(tf) >= 1 && wdTid4(tf) <= 3;
// Case folding for search.
const wdFold = (s) => String(s || '').toLowerCase();

function wdSafe(what, fn) {
  try {
    return fn();
  } catch (e) {
    Log.warn('Wardrobe (' + what + '): ' + ((e && e.message) || e));
    return undefined;
  }
}

function wdClone(v) {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return null;
  }
}

function wdItemName(ref) {
  return typeof Items !== 'undefined' && Items.name ? Items.name(ref) : '#' + ref;
}

function wdText(key, fallback) {
  return typeof Items !== 'undefined' && Items.text ? Items.text(key, fallback) || fallback : fallback;
}

// Icon path in the form the game stores for its own items ("item\china\...ddj");
// the catalogue gives "icon/item/...ddj" (the client's Gi() adds the icon/ root).
function wdGameIcon(ref) {
  const ddj = typeof Items !== 'undefined' && Items.iconDdj ? Items.iconDdj(ref) : '';
  return ddj ? String(ddj).replace(/^icon[\\/]/i, '').replace(/\//g, '\\') : '';
}

function wdSlotName(s) {
  const n = typeof Items !== 'undefined' && Items.slotName ? Items.slotName(s) : '';
  return n || ['Head', 'Chest', 'Shoulder', 'Hands', 'Legs', 'Feet', 'Weapon', 'Shield', 'Job suit'][s] || '';
}

function wdAvatarName(s) {
  return ['Hat', 'Dress', 'Attachment', 'Flag'][s] || '';
}

function wdKindName(kind) {
  const k = {
    SWORD: () => 'Sword',
    BLADE: () => 'Blade',
    SPEAR: () => 'Spear',
    TBLADE: () => 'Glaive',
    BOW: () => 'Bow',
    EUSWORD: () => 'One-handed sword',
    TSWORD: () => 'Two-handed sword',
    AXE: () => 'Dual axe',
    DARKSTAFF: () => 'Dark staff',
    TSTAFF: () => 'Two-handed staff',
    CROSSBOW: () => 'Crossbow',
    DAGGER: () => 'Dagger',
    HARP: () => 'Harp',
    STAFF: () => 'Staff',
    FORT: () => 'Fortress weapon',
    SHIELD: () => 'Shield',
  }[kind];
  return k ? k() : kind || '';
}

function wdClassName(cls, race) {
  const eu = race === 'EU';
  if (cls === 'CLOTHES') return eu ? 'Robe' : 'Garment';
  if (cls === 'LIGHT') return eu ? 'Light armour' : 'Protector';
  if (cls === 'HEAVY') return eu ? 'Heavy armour' : 'Armour';
  return '';
}

function wdBodyName(body) {
  return (
    {
      CH_M: () => 'Chinese male',
      CH_W: () => 'Chinese female',
      EU_M: () => 'European male',
      EU_W: () => 'European female',
    }[body] || (() => '—')
  )();
}

function wdSoxName(n) {
  return n ? wdText(['PARAM_RARE_FIRST', 'PARAM_RARE_SECOND', 'PARAM_RARE_THIRD'][n - 1], ['Seal of Star', 'Seal of Moon', 'Seal of Sun'][n - 1]) : '';
}

// +plus glow band (thresholds from the equipment GLB rows, R7 glow_pets).
function wdGlow(plus) {
  const p = Number(plus) || 0;
  if (p >= 9) return { name: 'Blue-green', color: '#6ff0d4' };
  if (p >= 7) return { name: 'Gold', color: '#ffc84a' };
  if (p >= 5) return { name: 'Pink', color: '#ff8ad8' };
  if (p >= 3) return { name: 'White', color: '#ffffff' };
  return { name: 'No glow', color: '#8f8a7a' };
}

// Parsed codename: weapons {race, kind, deg, grade, sox, honor}, armour {race, sex,
// cls, deg, part, ...}, job suits {job, deg}; sox 0 none | 1 Star | 2 Moon | 3 Sun.
function wdParse(code) {
  const c = String(code || '');
  const m = WD_RX.exec(c);
  if (m) {
    const sox = m[9] && /^(RARE|MAGIC|LEGEND|MYTH)$/.test(m[9]) ? 'ABC'.indexOf(m[8]) + 1 : 0;
    const base = { race: m[1], grade: m[8], sox, plain: !m[9] };
    if (m[6]) return { ...base, kind: m[6] === 'SWORD' && m[1] === 'EU' ? 'EUSWORD' : m[6], deg: +m[7] };
    return { ...base, sex: m[2], cls: m[3], deg: +m[4], part: m[5] };
  }
  let f = /^ITEM_FORT_FORTRESS_(HAMMER|AXE)_(\d+)/.exec(c);
  if (f) return { race: '', kind: 'FORT', deg: +f[2] || 0, sox: 0, plain: true };
  f = /_TRADE_(TRADER|THIEF|HUNTER)_(\d+)$/.exec(c);
  if (f) return { job: f[1], deg: +f[2] || 0, sox: 0, plain: true };
  if (/_FRPVP_VOUCHER_[A-E]$/.test(c)) return { job: 'VOUCHER', deg: 0, sox: 0, plain: true };
  const d = /_(\d\d)_/.exec(c);
  return { deg: d ? +d[1] : 0, sox: 0, plain: true };
}

const WdData = {
  rows: null, // [{id, code, slot, av, bodies:Set, glow, ac, m}]
  byId: new Map(),
  bodyByModel: new Map(), // character model refObjId -> body key
  modelName: new Map(), // cos / mount refObjId -> display name
  pets: [], // [{id, code, name, size}]
  mounts: [], // [{id, code, name}]
  petIds: new Set(),
  mountIds: new Set(),
  forBody: new Map(),
  promise: null,
  failedAt: -Infinity,
  error: '',
  texts: null, // merged textdata, for model names
  petsReady: false, // pet list built from a non-empty model list
  petPromise: null,
  petFailedAt: -Infinity,

  ready() {
    return !!this.rows;
  },

  // Loads once; a failure may be retried after 30 s (or right away from the window).
  load(force) {
    if (this.rows) return Promise.resolve(true);
    if (this.promise) return this.promise;
    if (!force && now() - this.failedAt < 30000) return Promise.resolve(false);
    this.error = '';
    this.promise = (async () => {
      const [wd, models, texts] = await Promise.all([
        Assets.wardrobe(),
        Assets.npcModels(),
        Assets.texts(),
        Items.ready(),
      ]);
      if (!wd || !Array.isArray(wd.items)) throw new Error('wardrobe catalogue unavailable');
      this.build(wd, Array.isArray(models) ? models : [], texts || {});
      return true;
    })()
      .catch((e) => {
        this.failedAt = now();
        this.error = String((e && e.message) || e);
        Log.warn('Wardrobe catalogue could not be loaded: ' + this.error);
        return false;
      })
      .finally(() => {
        this.promise = null;
      });
    return this.promise;
  },

  build(wd, models, texts) {
    const rows = [];
    const byId = new Map();
    for (const r of wd.items) {
      if (!Array.isArray(r) || !Number.isInteger(r[0])) continue;
      const slot = Number.isInteger(r[2]) && r[2] >= 0 && r[2] < 9 ? r[2] : -1;
      const av = Number.isInteger(r[3]) && r[3] >= 0 && r[3] < 4 ? r[3] : -1;
      if (slot < 0 && av < 0) continue;
      const row = { id: r[0], code: String(r[1] || ''), slot, av, bodies: new Set(String(r[4] || '').split(',').filter(Boolean)), glow: r[5] ? 1 : 0, ac: r[6] || 0 };
      row.m = wdParse(row.code);
      if (!row.m) continue;
      rows.push(row);
      byId.set(row.id, row);
    }
    const bodyByModel = new Map();
    const modelName = new Map();
    this.texts = texts;
    const mounts = [];
    for (const m of wd.models || []) {
      if (!Array.isArray(m)) continue;
      const mm = /^CHAR_(CH|EU)_(MAN|WOMAN)_/.exec(m[1] || '');
      if (mm) bodyByModel.set(m[0], mm[1] + '_' + (mm[2] === 'MAN' ? 'M' : 'W'));
      if (m[2]) {
        const name = this.nameOf(m[1]);
        mounts.push({ id: m[0], code: m[1], name });
        modelName.set(m[0], name);
      }
    }
    mounts.sort((a, b) => a.name.localeCompare(b.name));
    this.byId = byId;
    this.bodyByModel = bodyByModel;
    this.modelName = modelName;
    this.mounts = mounts;
    this.mountIds = new Set(mounts.map((p) => p.id));
    this.buildPets(models);
    if (!this.petsReady) this.petFailedAt = now();
    this.forBody.clear();
    this.rows = rows;
  },

  nameOf(code) {
    const texts = this.texts || {};
    const fam = code.replace(/_\d+$/, '');
    for (const k of [code, fam, fam + '_01']) if (texts['SN_' + k]) return texts['SN_' + k];
    return fam
      .replace(/^COS_[A-Z]_/, '')
      .toLowerCase()
      .replace(/(^|_)([a-z])/g, (_, s, ch) => (s ? ' ' : '') + ch.toUpperCase());
  },

  // Pets: one entry per family, two growth stages (first and last level model) when
  // the family has several. An empty model list (load failure) stays retryable.
  buildPets(models) {
    const fams = new Map();
    for (const m of models) {
      if (!Array.isArray(m) || m[2] !== 'cos' || !Number.isInteger(m[0])) continue;
      const code = String(m[1] || '');
      this.modelName.set(m[0], this.nameOf(code));
      const fam = code.replace(/_\d+$/, '');
      if (WD_PET_SKIP.has(fam)) continue;
      if (!fams.has(fam)) fams.set(fam, []);
      fams.get(fam).push({ id: m[0], code });
    }
    const pets = [];
    for (const [fam, list] of fams) {
      list.sort((a, b) => a.id - b.id);
      const name = this.nameOf(list[0].code);
      if (list.length === 1) pets.push({ id: list[0].id, code: list[0].code, name, size: '' });
      else {
        pets.push({ id: list[0].id, code: list[0].code, name, size: 'small', fam });
        pets.push({ id: list[list.length - 1].id, code: list[list.length - 1].code, name, size: 'large', fam });
      }
    }
    pets.sort((a, b) => a.name.localeCompare(b.name) || (a.size === 'large') - (b.size === 'large'));
    this.pets = pets;
    this.petIds = new Set(pets.map((p) => p.id));
    this.petsReady = pets.length > 0;
  },

  // Retries the pet model list after a failed load (at most every 30 s unless forced);
  // resolves true when the list was rebuilt.
  loadPets(force) {
    if (!this.rows || this.petsReady) return Promise.resolve(false);
    if (this.petPromise) return this.petPromise;
    if (!force && now() - this.petFailedAt < 30000) return Promise.resolve(false);
    this.petPromise = Promise.resolve(Assets.npcModels())
      .then((models) => {
        if (Array.isArray(models) && models.length) this.buildPets(models);
        if (!this.petsReady) this.petFailedAt = now();
        return this.petsReady;
      })
      .catch(() => {
        this.petFailedAt = now();
        return false;
      })
      .finally(() => {
        this.petPromise = null;
      });
    return this.petPromise;
  },

  rowsFor(body) {
    if (!this.rows || !body) return [];
    let list = this.forBody.get(body);
    if (!list) {
      list = this.rows.filter((r) => r.bodies.has(body));
      this.forBody.set(body, list);
    }
    return list;
  },

  bodyOf(modelRef) {
    return this.bodyByModel.get(modelRef) || '';
  },

  // Learned / formula typeFlags key of a catalogue row.
  classKey(row) {
    if (!row) return '';
    if (row.av >= 0) return 'v' + row.av;
    const m = row.m || {};
    if (row.slot === 6) return 'w:' + (m.kind || '');
    if (row.slot === 7) return 's:' + (m.race || '');
    if (row.slot >= 0 && row.slot < 6) return 'a:' + (m.race || '') + ':' + (m.cls || row.ac) + ':' + row.slot;
    if (row.slot === 8) return 'j:' + (m.job || '');
    return '';
  },

  // typeFlags by the standard layout (R2 / R7 appearance step 3), 0 when unknown.
  formulaTf(row) {
    if (!row) return 0;
    const m = row.m || {};
    if (row.av >= 0) return (((row.av + 1) << 11) | 1708) >>> 0;
    if (row.slot === 6) return WD_WEAPON_T4[m.kind] ? wdTf(WD_WEAPON_T4[m.kind], 6) : 0;
    if (row.slot === 7) return wdTf(m.race === 'EU' ? 2 : 1, 4);
    if (row.slot >= 0 && row.slot < 6) {
      const t3 = (WD_ARMOR_T3[m.cls] || clamp(row.ac || 1, 1, 3)) + (m.race === 'EU' ? 8 : 0);
      return wdTf(WD_SLOT_T4[row.slot], t3);
    }
    if (row.slot === 8) return wdTf(WD_JOB_T4[m.job] || 1, 7);
    return 0;
  },
};

const Wardrobe = {
  win: null,
  cssDone: false,
  // Arrays handed to the game, and the arrays they were built from.
  inv: null,
  baseInv: null,
  av: null,
  baseAv: null,
  body: '', // body key of the local character model
  learned: new Map(), // classKey -> typeFlags seen on real items
  warned: new Set(),
  applyTimer: 0,
  leftTimer: 0,
  learnAt: 0,
  sig: '',
  hsig: '',
  loadReq: false,
  view: { tab: 'items', slot: 'e6', q: '', kind: '', cls: '', deg: 0, rar: '', page: 0 },
  setOpt: { deg: 0, cls: '', sox: 0, weapon: '', shield: false, plus: 0 },
  el: {},

  // ---- state -------------------------------------------------------------------

  cfg() {
    const c = WdCfg();
    if (!c.eq || typeof c.eq !== 'object' || Array.isArray(c.eq)) c.eq = {};
    if (!c.av || typeof c.av !== 'object' || Array.isArray(c.av)) c.av = {};
    if (!c.pet || typeof c.pet !== 'object') c.pet = { atk: 0, pick: 0, mount: 0 };
    if (!c.presets || typeof c.presets !== 'object' || Array.isArray(c.presets)) c.presets = {};
    return c;
  },

  active() {
    return !!(this.cfg().on && WdData.ready() && this.body);
  },

  hasOverrides(c = this.cfg()) {
    return Object.keys(c.eq).length > 0 || Object.keys(c.av).length > 0 || !!(c.pet.atk || c.pet.pick || c.pet.mount) || !!c.hideAvatars;
  },

  outfit() {
    const c = this.cfg();
    return wdClone({ eq: c.eq, av: c.av, pet: c.pet, hideAvatars: !!c.hideAvatars });
  },

  useOutfit(o) {
    const c = this.cfg();
    const x = wdClone(o) || {};
    c.eq = x.eq && typeof x.eq === 'object' ? x.eq : {};
    c.av = x.av && typeof x.av === 'object' ? x.av : {};
    c.pet = { atk: wdInt(x.pet?.atk, 0, 4294967295), pick: wdInt(x.pet?.pick, 0, 4294967295), mount: wdInt(x.pet?.mount, 0, 4294967295) };
    c.hideAvatars = !!x.hideAvatars;
  },

  snapshot() {
    this.cfg().undo = this.outfit();
  },

  petKey() {
    const p = this.cfg().pet;
    return [p.atk || 0, p.pick || 0, p.mount || 0].join();
  },

  // Catalogue row of an equipment override when it may be handed to the game.
  validEq(slot, ref) {
    const row = ref ? WdData.byId.get(Number(ref)) : null;
    return row && row.slot === slot && row.bodies.has(this.body) ? row : null;
  },

  validAv(slot, ref) {
    const row = ref ? WdData.byId.get(Number(ref)) : null;
    return row && row.av === slot && row.bodies.has(this.body) ? row : null;
  },

  // Real item typeFlags win over the formula (and disagreements are logged once).
  tfFor(row) {
    const key = WdData.classKey(row);
    const seen = key ? this.learned.get(key) : undefined;
    return seen !== undefined ? seen : WdData.formulaTf(row);
  },

  learn() {
    if (!WdData.ready()) return;
    const add = (ref, tf) => {
      if (!Number.isInteger(ref) || !isNum(tf)) return;
      const row = WdData.byId.get(ref);
      const key = WdData.classKey(row);
      if (!key || this.learned.has(key)) return;
      const real = (Number(tf) >>> 0) & ~1; // bit 0 marks mall items
      this.learned.set(key, real);
      const f = WdData.formulaTf(row);
      if (f && f !== real && !this.warned.has(key)) {
        this.warned.add(key);
        Log.warn(`Wardrobe: ${row.code} typeFlags ${real}, formula ${f} (using the real value)`);
      }
    };
    const gp = World.gp;
    for (const it of Array.isArray(gp?.inventory) ? gp.inventory : []) if (it) add(it.refObjId, it.typeFlags);
    for (const it of Array.isArray(gp?.avatarInventory) ? gp.avatarInventory : []) if (it) add(it.refObjId, it.typeFlags);
    for (const e of World.ents.values()) {
      if (e && Array.isArray(e.equipment)) for (const q of e.equipment) if (q) add(q.refObjId, q.typeFlags);
      if (e && Array.isArray(e.avatars)) for (const q of e.avatars) if (q) add(q.refObjId, q.typeFlags);
    }
  },

  // ---- what the game is given ---------------------------------------------------

  // slot -> { item } (replace / add) or { hide: true } for the equipment overrides.
  eqPlan(base) {
    const plan = new Map();
    if (!this.active()) return plan;
    const c = this.cfg();
    const realArmor = base.find((it) => it && it.slot >= 0 && it.slot < 6 && [1, 2, 3, 9, 10, 11].includes(wdTid3(it.typeFlags)) && wdIsEquip(it.typeFlags));
    for (let s = 0; s < 9; s++) {
      const o = c.eq[s];
      if (!o || typeof o !== 'object') continue;
      const real = base.find((it) => it && it.slot === s) || null;
      if (o.hide) {
        // A worn job suit stays: dropping it would switch the game to normal mode.
        if (real && !(s === 8 && wdJobMode(real.typeFlags))) plan.set(s, { hide: true });
        continue;
      }
      const row = this.validEq(s, o.ref);
      const plusOv = (s === 6 || s === 7) && o.plus != null && isNum(Number(o.plus)) ? wdInt(o.plus, 0, 255) : null;
      if (!row && plusOv == null) continue;
      if (real) {
        const sameClass = this.groupOf(real.typeFlags) === this.slotGroup(s);
        const realPlus = Number.isInteger(real.plus) && real.plus >= 0 && real.plus <= 255 ? real.plus : 0;
        if (!row) {
          if (sameClass && plusOv !== realPlus) plan.set(s, { item: { ...real, plus: plusOv } });
          continue;
        }
        if (row.id === real.refObjId && plusOv == null) continue;
        if (sameClass) {
          const tf = s === 6 ? this.weaponTf(row, real.typeFlags) : real.typeFlags;
          plan.set(s, { item: { ...real, refObjId: row.id, typeFlags: tf, plus: plusOv ?? realPlus } });
        } else {
          plan.set(s, { item: this.standIn(s, row, plusOv ?? 0, realArmor, real) });
        }
      } else if (row && c.phantom) {
        plan.set(s, { item: this.standIn(s, row, plusOv ?? 0, realArmor, null), add: true });
      }
    }
    return plan;
  },

  // Slot 6 typeFlags of a fake weapon. It picks the stance (wh()) and the skill clip
  // family (As()); with "animations follow the real weapon" on, a fake of another
  // family keeps the real family (no weapon = tid4 0, unarmed), so casts never lose
  // their clips.
  weaponTf(row, realTf) {
    const base = realTf != null ? Number(realTf) >>> 0 : wdTf(0, 6);
    const fake = this.tfFor(row) || 0;
    if (!fake) return base;
    if (!this.cfg().realAnim) return fake;
    return wdAnimFam(fake) === wdAnimFam(base) ? fake : base;
  },

  // Item object for a slot without a real item of the same class: every field the
  // game's inventory UI reads (icon, name, typeFlags, quantity, plus, durability,
  // variance as BigInt string, magic arrays), no tooltip so it is shown by name only.
  standIn(s, row, plus, realArmor, real) {
    let tf = this.tfFor(row);
    // Same armour class as the real armour, so the game does not mark real parts as a
    // mixed set (w_ L2236); the drawn model does not depend on it.
    if (s < 6 && realArmor && tf) tf = wdTf(wdTid4(tf), wdTid3(realArmor.typeFlags));
    // The weapon keeps the real animation family (or unarmed) unless the user opted out.
    if (s === 6) tf = this.weaponTf(row, real && this.groupOf(real.typeFlags) === 'w' ? real.typeFlags : null);
    // A job suit stand-in must read as normal mode (tid4 0) for ac(); the job mode only
    // ever comes from a real suit, whose typeFlags are kept on the other path.
    if (s === 8) tf = wdTf(0, 7);
    if (!tf) tf = s === 7 ? wdTf(1, 4) : wdTf(WD_SLOT_T4[s] || 1, 1);
    return {
      slot: s,
      refObjId: row.id,
      typeFlags: tf,
      plus: wdInt(plus, 0, 255),
      quantity: 1,
      durability: 0,
      variance: real && real.variance ? real.variance : '0',
      magic: real && Array.isArray(real.magic) ? real.magic.slice() : [],
      magicReferences: real && Array.isArray(real.magicReferences) ? real.magicReferences.slice() : [],
      name: wdItemName(row.id),
      icon: wdGameIcon(row.id),
    };
  },

  groupOf(tf) {
    if (!wdIsEquip(tf)) return 'n';
    const t3 = wdTid3(tf);
    return t3 === 6 ? 'w' : t3 === 4 ? 's' : t3 === 7 ? 'j' : [1, 2, 3, 9, 10, 11].includes(t3) ? 'a' : 'x';
  },

  slotGroup(s) {
    return s === 6 ? 'w' : s === 7 ? 's' : s === 8 ? 'j' : 'a';
  },

  buildInv(base) {
    const plan = this.eqPlan(base);
    if (!plan.size) return base.slice();
    const out = [];
    const done = new Set();
    for (const it of base) {
      const s = it && it.slot;
      if (Number.isInteger(s) && s >= 0 && s < 9 && plan.has(s)) {
        done.add(s);
        const p = plan.get(s);
        if (p.item) out.push(p.item);
        continue;
      }
      out.push(it);
    }
    for (const [s, p] of plan) {
      if (done.has(s) || !p.add || !p.item) continue;
      const at = out.findIndex((it) => it && Number.isInteger(it.slot) && it.slot > s);
      if (at < 0) out.push(p.item);
      else out.splice(at, 0, p.item);
    }
    return out;
  },

  avSlotOf(a) {
    const row = WdData.byId.get(a && a.refObjId);
    return row && row.av >= 0 ? row.av : wdTid4(a && a.typeFlags) - 1;
  },

  avTf(s) {
    const seen = this.learned.get('v' + s);
    return seen !== undefined ? seen : (((s + 1) << 11) | 1708) >>> 0;
  },

  buildAv(base) {
    if (!this.active()) return base.slice();
    const c = this.cfg();
    if (c.hideAvatars) return [];
    const over = new Map(); // avatarSlot -> row | null (hidden)
    for (let s = 0; s < 4; s++) {
      const o = c.av[s];
      if (!o || typeof o !== 'object') continue;
      if (o.hide) over.set(s, null);
      else {
        const row = this.validAv(s, o.ref);
        if (row) over.set(s, row);
      }
    }
    if (!over.size) return base.slice();
    const out = base.filter((a) => a && !over.has(this.avSlotOf(a)));
    for (const [s, row] of over) if (row) out.push({ slot: s, refObjId: row.id, typeFlags: this.avTf(s), plus: 0 });
    return out;
  },

  // Gameplay rewriter: always hands the game a copy of the inventory array (kept for
  // in-place updates), with the overrides applied.
  onGameplay(st) {
    if (!st || typeof st !== 'object' || !Array.isArray(st.inventory)) return undefined;
    const next = this.buildInv(st.inventory);
    this.baseInv = st.inventory;
    this.inv = next;
    return { ...st, inventory: next };
  },

  // Entity rewriter: the local player's avatars (always a copy, kept for in-place
  // updates) and the models of the player's own pet and ridden COS.
  onEntity(e) {
    if (!e || typeof e !== 'object') return undefined;
    if (e.kind === 'local-player') {
      if (WdData.ready()) {
        const b = WdData.bodyOf(e.refObjId);
        if (b !== this.body) {
          this.body = b;
          this.rebuildInv();
        }
      }
      const base = Array.isArray(e.avatars) ? e.avatars : [];
      const next = this.buildAv(base);
      this.baseAv = base;
      this.av = next;
      return { ...e, avatars: next };
    }
    if (e.kind === 'cos') return this.petLook(e);
    return undefined;
  },

  petLook(e) {
    const c = this.cfg();
    if (!c.on || !WdData.ready()) return undefined;
    const lg = World.localGid();
    const t4 = (Number(e.tidWord) >>> 11) & 31;
    const local = World.local();
    let want = 0;
    if (local && local.mountedOn === e.gid && (t4 === 1 || t4 === 2)) want = WdData.mountIds.has(c.pet.mount) ? c.pet.mount : 0;
    else if (lg && e.ownerGid === lg && t4 === 3) want = WdData.petIds.has(c.pet.atk) ? c.pet.atk : 0;
    else if (lg && e.ownerGid === lg && t4 === 4) want = WdData.petIds.has(c.pet.pick) ? c.pet.pick : 0;
    if (!want || want === e.refObjId) return undefined;
    return { ...e, refObjId: want };
  },

  rebuildInv() {
    if (!this.inv || !this.baseInv) return;
    const next = this.buildInv(this.baseInv);
    this.inv.length = 0;
    for (const it of next) this.inv.push(it);
  },

  // Writes the current overrides into the arrays the game holds (next frame).
  applyNow() {
    wdSafe('uygula', () => {
      this.rebuildInv();
      if (this.av && this.baseAv) {
        const next = this.buildAv(this.baseAv);
        this.av.length = 0;
        for (const a of next) this.av.push(a);
      }
    });
  },

  applySoon() {
    if (this.applyTimer) return;
    this.applyTimer = setTimeout(() => {
      this.applyTimer = 0;
      this.applyNow();
    }, 40);
  },

  // pet: true only when the pet / mount look really changed (the toast explains the
  // delay until the animal's next update).
  changed(pet) {
    Settings.saveProfile();
    this.applySoon();
    const out = this.myCos();
    if (pet && (out.p3 || out.p4 || out.pm)) UI.toast('The pet and mount look changes with the animal’s next update (movement).', 'info', 3500);
    if (this.isOpen()) {
      this.renderLeft();
      this.renderHead();
      this.markGrid();
    }
  },

  // ---- actions --------------------------------------------------------------------

  ensureEq(s) {
    const c = this.cfg();
    if (!c.eq[s] || typeof c.eq[s] !== 'object') c.eq[s] = {};
    return c.eq[s];
  },

  tidyEq(s) {
    const c = this.cfg();
    const o = c.eq[s];
    if (o && !o.ref && o.plus == null && !o.hide) delete c.eq[s];
  },

  pick(row) {
    const id = this.view.slot;
    const c = this.cfg();
    if (id[0] === 'e') {
      const s = +id.slice(1);
      const o = this.ensureEq(s);
      if (o.ref === row.id && !o.hide) delete o.ref;
      else {
        o.ref = row.id;
        delete o.hide;
      }
      this.tidyEq(s);
    } else if (id[0] === 'a') {
      const s = +id.slice(1);
      if (c.av[s] && c.av[s].ref === row.id) delete c.av[s];
      else c.av[s] = { ref: row.id };
    }
    this.changed(false);
  },

  setPet(kind, ref) {
    const c = this.cfg();
    const before = c.pet[kind] || 0;
    c.pet[kind] = before === ref ? 0 : ref || 0;
    this.changed(c.pet[kind] !== before);
    if (this.isOpen()) this.renderPane();
  },

  resetSlot(id) {
    const c = this.cfg();
    const pets = this.petKey();
    if (id[0] === 'e') delete c.eq[+id.slice(1)];
    else if (id[0] === 'a') delete c.av[+id.slice(1)];
    else if (id === 'p3') c.pet.atk = 0;
    else if (id === 'p4') c.pet.pick = 0;
    else if (id === 'pm') c.pet.mount = 0;
    this.changed(this.petKey() !== pets);
    if (this.isOpen() && id[0] === 'p' && this.view.slot === id) this.renderPane();
  },

  toggleHide(id) {
    const c = this.cfg();
    if (id[0] === 'e') {
      const s = +id.slice(1);
      const o = this.ensureEq(s);
      const real = this.realEq(s);
      if (o.hide) delete o.hide;
      else if (s === 8 && real && wdJobMode(real.typeFlags)) {
        UI.toast('A worn job suit cannot be hidden: the game reads the job mode from this slot.', 'warn', 4000);
      } else {
        o.hide = true;
        if (s === 6 && real) UI.toast('With the weapon hidden, skill animations and hit effects may not play.', 'warn', 4000);
      }
      this.tidyEq(s);
    } else if (id[0] === 'a') {
      const s = +id.slice(1);
      if (c.av[s] && c.av[s].hide) delete c.av[s];
      else c.av[s] = { hide: true };
    }
    this.changed(false);
  },

  resetAll() {
    if (!this.hasOverrides()) return;
    this.snapshot();
    const pets = this.petKey();
    this.useOutfit({ eq: {}, av: {}, pet: { atk: 0, pick: 0, mount: 0 }, hideAvatars: false });
    this.changed(this.petKey() !== pets);
    UI.toast('Back to the real look ("Undo" restores the previous outfit).', 'info', 3000);
    if (this.isOpen()) this.renderPane();
  },

  undo() {
    const c = this.cfg();
    if (!c.undo) return;
    const cur = this.outfit();
    const pets = this.petKey();
    this.useOutfit(c.undo);
    c.undo = cur;
    this.changed(this.petKey() !== pets);
    if (this.isOpen()) this.renderPane();
  },

  randomize() {
    const rows = WdData.rowsFor(this.body);
    if (!rows.length) return;
    this.snapshot();
    const c = this.cfg();
    const any = (list) => list[Math.floor(Math.random() * list.length)];
    const eq = {};
    for (let s = 0; s < 6; s++) {
      const l = rows.filter((r) => r.slot === s);
      if (l.length) eq[s] = { ref: any(l).id };
    }
    const weapons = rows.filter((r) => r.slot === 6 && r.m.kind && r.m.kind !== 'FORT');
    if (weapons.length) {
      const w = any(weapons);
      eq[6] = { ref: w.id, plus: Math.floor(Math.random() * 13) };
      const shields = rows.filter((r) => r.slot === 7);
      const realShield = this.realEq(7);
      if (WD_ONE_HAND.has(w.m.kind) && shields.length && Math.random() < 0.7) eq[7] = { ref: any(shields).id, plus: Math.floor(Math.random() * 13) };
      // Only a real shield is hidden next to a two-handed weapon; arrows and bolts stay.
      else if (realShield && this.groupOf(realShield.typeFlags) === 's') eq[7] = { hide: true };
    }
    const av = {};
    for (let s = 0; s < 4; s++) {
      const l = rows.filter((r) => r.av === s);
      if (l.length && Math.random() < (s === 1 ? 0.3 : 0.5)) av[s] = { ref: any(l).id };
    }
    c.eq = eq;
    c.av = av;
    c.hideAvatars = false;
    this.changed(false);
    if (this.isOpen()) this.renderPane();
  },

  // Best row of a slot for the set builder: exact SoX grade first, then the plain
  // A-grade item, honour and _DEF/_SUPER variants last.
  bestRow(rows, slot, test) {
    let best = null;
    let score = -1;
    for (const r of rows) {
      if (r.slot !== slot || !test(r)) continue;
      const sc = (r.m.honor ? 0 : 4) + (r.m.plain || r.m.sox ? 2 : 0) + (r.m.grade === 'A' ? 1 : 0);
      if (sc > score || (sc === score && r.id < best.id)) {
        best = r;
        score = sc;
      }
    }
    return best;
  },

  // Puts the chosen set on; armour slots the set has no piece for are cleared so no
  // part of an older outfit stays mixed in. Returns {n, miss}.
  applySet() {
    const o = this.setOpt;
    const rows = WdData.rowsFor(this.body);
    if (!rows.length || !o.deg || !o.cls) return { n: 0, miss: 0 };
    this.snapshot();
    const c = this.cfg();
    const soxOk = (r) => (o.sox ? r.m.sox === o.sox : !r.m.sox);
    let n = 0;
    let miss = 0;
    const parts = [0, 1, 2, 3, 4, 5].map((s) => this.bestRow(rows, s, (x) => x.m.cls === o.cls && x.m.deg === o.deg && soxOk(x)));
    // With no armour piece at all the armour overrides are left alone.
    if (parts.some(Boolean)) {
      parts.forEach((r, s) => {
        if (r) {
          c.eq[s] = { ref: r.id };
          n++;
        } else {
          delete c.eq[s];
          miss++;
        }
      });
    }
    // Weapon / shield of the same degree, or the closest lower degree that exists.
    const near = (slot, test) => {
      for (let d = o.deg; d >= 1; d--) {
        const r = this.bestRow(rows, slot, (x) => x.m.deg === d && test(x) && soxOk(x));
        if (r) return r;
      }
      return null;
    };
    const plus = wdInt(o.plus, 0, 255);
    if (o.weapon) {
      const w = near(6, (x) => x.m.kind === o.weapon);
      if (w) {
        c.eq[6] = { ref: w.id, plus };
        n++;
      }
    }
    if (o.shield) {
      const sh = near(7, () => true);
      if (sh) {
        c.eq[7] = { ref: sh.id, plus };
        n++;
      }
    }
    this.changed(false);
    return { n, miss };
  },

  savePreset(name) {
    const key = String(name || '')
      .trim()
      .slice(0, 32);
    if (!key || /^(__proto__|constructor|prototype)$/.test(key)) return false;
    const c = this.cfg();
    if (!Object.prototype.hasOwnProperty.call(c.presets, key) && Object.keys(c.presets).length >= 40) {
      UI.toast('Up to 40 outfits can be stored.', 'warn', 2500);
      return false;
    }
    c.presets[key] = this.outfit();
    Settings.saveProfile();
    return true;
  },

  loadPreset(name) {
    const presets = this.cfg().presets;
    const p = Object.prototype.hasOwnProperty.call(presets, name) ? presets[name] : null;
    if (!p || typeof p !== 'object') return;
    this.snapshot();
    const pets = this.petKey();
    this.useOutfit(p);
    this.changed(this.petKey() !== pets);
  },

  deletePreset(name) {
    delete this.cfg().presets[name];
    Settings.saveProfile();
  },

  myCos() {
    const out = { p3: null, p4: null, pm: null };
    const lg = World.localGid();
    const local = World.local();
    if (!lg) return out;
    for (const e of World.ents.values()) {
      if (!e || e.kind !== 'cos') continue;
      const t4 = (Number(e.tidWord) >>> 11) & 31;
      if (local && local.mountedOn === e.gid) out.pm = e;
      else if (e.ownerGid === lg && t4 === 3) out.p3 = e;
      else if (e.ownerGid === lg && t4 === 4) out.p4 = e;
    }
    return out;
  },

  realEq(s) {
    const inv = Array.isArray(World.gp?.inventory) ? World.gp.inventory : [];
    return inv.find((it) => it && it.slot === s) || null;
  },

  realAv(s) {
    const l = World.local();
    return (l?.avatars || []).find((a) => a && this.avSlotOf(a) === s) || null;
  },

  isOpen() { return false; },
  ensureData(force = false) { return LeanWardrobe.load(force); },
  tick() {
    if (!WdData.ready()) {
      if (World.inWorld() && this.cfg().on && this.hasOverrides()) this.ensureData();
      return;
    }
    const body = WdData.bodyOf(World.local()?.refObjId);
    if (body && body !== this.body) { this.body = body; this.applyNow(); }
    if (now() - this.learnAt > 2000) { this.learnAt = now(); this.learn(); }
  },
};
Display.addGameplay('wardrobe', st => Wardrobe.onGameplay(st));
Display.add('wardrobe', e => Wardrobe.onEntity(e));


// Original validated appearance core with a compact, lazy catalogue browser.
const Assets = {
  cache: new Map(),
  json(path) {
    if (!this.cache.has(path)) this.cache.set(path, Icons.request(path, 'json').catch(e => { this.cache.delete(path); throw e; }));
    return this.cache.get(path);
  },
  texts() { return this.json('/assets/text/textdataname.en.json').then(r => r.entries || {}); },
  async wardrobe() {
    const r = await this.json('/assets/char/roster.json'), d = r.dress || {}, items = [];
    for (const [id, e] of Object.entries(d.equipment || {})) {
      if (!e || (e.slot == null && e.avatarSlot == null)) continue;
      const bodies = Object.keys(e.bodies || {}).filter(k => e.bodies[k] && typeof e.bodies[k] === 'object');
      if (bodies.length) items.push([Number(id), e.code || '', e.slot ?? -1, e.avatarSlot ?? -1, bodies.join(','), d.specialGlows?.[id] ? 1 : 0, e.armorClass || 0]);
    }
    return { items, models: Object.values(r.models || {}).map(m => [m.refObjId, m.codename || '', m.isMount ? 1 : 0]) };
  },
  async npcModels() {
    const r = await this.json('/assets/npc/manifest.json');
    return Object.values(r.models || {}).filter(v => v?.refObjId != null).map(v => [v.refObjId, v.codename || '', v.kind || '']);
  },
};
const Items = {
  data: new Map(), pending: null,
  ready() {
    if (this.pending) return this.pending;
    this.pending = Promise.all([Assets.json('/assets/data/missionPresentation.json'), Assets.texts()]).then(([r, names]) => {
      for (const [id, v] of Object.entries(r.itemsByRefObjId || {})) {
        if (!v?.codename) continue;
        const code = v.codename, generic = code.replace(/^ITEM_(CH|EU)_[MW]_/, 'ITEM_$1_');
        let name = names['SN_' + code] || names['SN_' + generic], shortened = generic;
        while (!name && shortened.includes('_')) { shortened = shortened.slice(0, shortened.lastIndexOf('_')); name = names['SN_' + shortened]; }
        this.data.set(Number(id), { name: name || code, icon: v.iconDdjPath || '', code });
      }
    }).catch(e => { this.pending = null; throw e; });
    return this.pending;
  },
  name(id) { return this.data.get(id)?.name || WdData.byId.get(id)?.code || '#' + id; },
  iconDdj(id) { return this.data.get(id)?.icon || ''; },
  // 0 none | 1 Star | 2 Moon | 3 Sun, from the codename rule _[ABC]_RARE (also MAGIC/LEGEND/MYTH, HONOR).
  // Real inventory/pet items carry tooltip rarity (2 = seal tiers) and a Star/Moon/Sun class; otherwise use the codename rule.
  soxOf(item) {
    const f = item?.tooltip?.fields;
    if (f && f.rarity !== undefined) {
      if (f.rarity !== 2) return 0;
      if (f.itemClass) return ((f.itemClass - 1) % 3) + 1;
    }
    const m = /_([ABC])_(RARE|MAGIC|LEGEND|MYTH)(?:_HONOR)?$/.exec(item?.codename || this.data.get(item?.refObjId)?.code || '');
    return m ? 'ABC'.indexOf(m[1]) + 1 : f?.rarity === 2 ? 1 : 0;
  },
  sox(id) { const m = /_([ABC])_(RARE|MAGIC|LEGEND|MYTH)(?:_HONOR)?$/.exec(this.data.get(id)?.code || ''); return m ? 'ABC'.indexOf(m[1]) + 1 : 0; },
};
const LeanWardrobe = {
  slot: 'e6', query: '', degree: 0, rarity: '', page: 0, loading: null, preset: '',
  load(force = false) {
    if (this.loading) return this.loading;
    this.loading = WdData.load(force).then(ok => {
      if (ok) { Wardrobe.body = WdData.bodyOf(World.local()?.refObjId); Wardrobe.learn(); Wardrobe.applyNow(); }
      if (UI.current === 'Wardrobe') UI.draw();
      return ok;
    }).finally(() => { this.loading = null; });
    return this.loading;
  },
  change(fn) { fn(); Wardrobe.changed(false); UI.draw(); },
  chooseSlot(slot) {
    this.slot = slot; Wardrobe.view.slot = slot;
    this.query = ''; this.degree = 0; this.rarity = ''; this.page = 0;
    UI.draw();
  },
  rows() {
    const q = wdFold(this.query);
    if (this.slot[0] === 'p') {
      const list = this.slot === 'pm' ? WdData.mounts : WdData.pets;
      return list.filter(r => wdFold(r.name + ' ' + r.code + ' ' + (r.size || '')).includes(q));
    }
    const number = Number(this.slot.slice(1)), equipment = this.slot[0] === 'e';
    return WdData.rowsFor(Wardrobe.body).filter(r => (equipment ? r.slot === number : this.slot === 'a*' ? r.av >= 0 : r.av === number) &&
      (!equipment || ((!this.degree || r.m.deg === this.degree) && (!this.rarity || String(r.m.sox) === this.rarity))) && wdFold(Items.name(r.id) + ' ' + r.code).includes(q));
  },
  draw(parent) {
    const c = Wardrobe.cfg();
    const actions = UI.group('Appearance studio',
      UI.check('Enable wardrobe', () => c.on, v => { c.on = v; Wardrobe.changed(true); }),
      UI.check('Keep real weapon animations', () => c.realAnim, v => { c.realAnim = v; Wardrobe.changed(false); }),
      UI.check('Show skins in empty slots', () => c.phantom, v => { c.phantom = v; Wardrobe.changed(false); }),
      UI.check('Hide avatars', () => c.hideAvatars, v => { c.hideAvatars = v; Wardrobe.changed(false); }),
      UI.row(UI.button('Random outfit', () => this.change(() => Wardrobe.randomize())), UI.button('Real look', () => this.change(() => Wardrobe.resetAll())), UI.button('Undo', () => this.change(() => Wardrobe.undo()))),
      el('p', 'Preview outfits on your character. Looks are visible to you only; equipment stats stay real. Import original settings to restore your previous outfits.', 'muted'));
    parent.append(actions);
    if (!WdData.ready()) {
      const state = el('p', WdData.error ? 'Catalogue could not load: ' + WdData.error : 'Loading wardrobe catalogue…', 'muted');
      parent.append(UI.group('Catalogue', state, UI.button('Retry catalogue', () => this.load(true))));
      if (!WdData.error) this.load();
      return;
    }
    Wardrobe.body = WdData.bodyOf(World.local()?.refObjId);
    if (!Wardrobe.body) { parent.append(el('p', 'Enter the world so the wardrobe can match skins to your character body.', 'muted')); return; }
    const categories = el('div', null, 'subtabs');
    for (const [label, slot] of [['Equipment', 'e6'], ['Avatars / paid skins', 'a*'], ['Pets & mounts', 'p4']]) {
      const button = UI.button(label, () => this.chooseSlot(slot)); button.setAttribute('aria-selected', String(this.slot[0] === slot[0])); categories.append(button);
    }
    parent.append(categories);
    const slots = [...Array.from({ length: 9 }, (_, s) => ['e' + s, wdSlotName(s)]), ['a*', 'All avatar skins'], ...Array.from({ length: 4 }, (_, s) => ['a' + s, 'Avatar ' + wdAvatarName(s)]), ['p3', 'Attack pet'], ['p4', 'Pickup pet'], ['pm', 'Mount']];
    const catalog = UI.group('Skins for ' + Wardrobe.body,
      UI.select('Appearance slot', slots, () => this.slot, v => this.chooseSlot(v)));
    if (this.slot[0] === 'e') catalog.append(
      UI.select('Degree', [[0, 'All'], ...Array.from({ length: 15 }, (_, i) => [i + 1, 'Degree ' + (i + 1)])], () => this.degree, v => { this.degree = Number(v); this.page = 0; UI.draw(); }),
      UI.select('Seal', [['', 'All'], ['0', 'Normal'], ['1', 'Star'], ['2', 'Moon'], ['3', 'Sun']], () => this.rarity, v => { this.rarity = v; this.page = 0; UI.draw(); }));
    if (this.slot[0] === 'a') catalog.append(el('p', 'All compatible avatar looks in the game catalogue, including paid skins, whether owned or not. This is a local appearance preview; it does not buy items or grant ownership.', 'muted'));
    const search = el('input'); search.type = 'search'; search.placeholder = 'Search name or skin code'; search.value = this.query; search.setAttribute('aria-label', 'Search wardrobe');
    const results = el('div'), refresh = () => this.results(results);
    search.addEventListener('input', () => { this.query = search.value; this.page = 0; refresh(); });
    const hide = UI.button('Hide slot', () => this.change(() => Wardrobe.toggleHide(this.slot))); hide.disabled = this.slot[0] === 'p' || this.slot === 'a*';
    const reset = UI.button('Reset slot', () => this.change(() => Wardrobe.resetSlot(this.slot))); reset.disabled = this.slot === 'a*';
    catalog.append(UI.field('Search wardrobe', search), UI.row(
      reset, hide));
    if (this.slot === 'e6' || this.slot === 'e7') catalog.append(UI.number('Weapon / shield glow (+)', () => c.eq[Number(this.slot.slice(1))]?.plus ?? 0,
      v => { Wardrobe.ensureEq(Number(this.slot.slice(1))).plus = v; Wardrobe.changed(false); }, 0, 255));
    catalog.append(results); parent.append(catalog); refresh();
    const opt = Wardrobe.setOpt;
    const set = UI.group('Matching set',
      UI.select('Armour', [['CLOTHES', 'Garment / Robe'], ['LIGHT', 'Protector / Light'], ['HEAVY', 'Armour / Heavy']], () => opt.cls || 'CLOTHES', v => opt.cls = v),
      UI.number('Set degree', () => opt.deg || 1, v => opt.deg = v, 1, 15),
      UI.select('Set seal', [[0, 'Normal'], [1, 'Star'], [2, 'Moon'], [3, 'Sun']], () => opt.sox, v => opt.sox = Number(v)),
      UI.select('Matching weapon', [['', 'Keep current'], ...[...new Set(WdData.rowsFor(Wardrobe.body).filter(r => r.slot === 6 && r.m.kind && r.m.kind !== 'FORT').map(r => r.m.kind))].map(kind => [kind, wdKindName(kind)])], () => opt.weapon, v => opt.weapon = v),
      UI.check('Include matching shield', () => opt.shield, v => opt.shield = v),
      UI.number('Set weapon / shield glow (+)', () => opt.plus, v => opt.plus = v, 0, 255),
      UI.button('Wear matching armour', () => this.change(() => { opt.cls ||= 'CLOTHES'; opt.deg ||= 1; const result = Wardrobe.applySet(); if (result) UI.toast('Applied ' + result.n + ' parts; ' + result.miss + ' unavailable.'); })));
    parent.append(set);
    const name = el('input'); name.type = 'text'; name.maxLength = 32; name.placeholder = 'Outfit name'; name.setAttribute('aria-label', 'Outfit name');
    const presets = UI.group('Saved outfits', name,
      UI.button('Save outfit', () => this.change(() => Wardrobe.savePreset(name.value))),
      UI.select('Outfit', () => [['', 'Choose outfit'], ...Object.keys(c.presets).map(k => [k, k])], () => this.preset, v => this.preset = v),
      UI.row(UI.button('Wear outfit', () => this.change(() => Wardrobe.loadPreset(this.preset))), UI.button('Delete outfit', () => this.change(() => Wardrobe.deletePreset(this.preset)))));
    parent.append(presets);
  },
  results(parent) {
    parent.replaceChildren();
    const rows = this.rows(), count = 48, pages = Math.max(1, Math.ceil(rows.length / count));
    this.page = Math.min(this.page, pages - 1);
    parent.append(el('p', rows.length + ' compatible skins · page ' + (this.page + 1) + '/' + pages, 'muted'));
    const grid = el('div', null, 'wardrobe-grid');
    for (const row of rows.slice(this.page * count, (this.page + 1) * count)) {
      const pet = this.slot[0] === 'p', title = pet ? row.name + (row.size ? ' · ' + row.size : '') : Items.name(row.id);
      const targetSlot = this.slot === 'a*' ? 'a' + row.av : this.slot;
      const button = UI.button('', () => this.change(() => { Wardrobe.view.slot = targetSlot; if (pet) Wardrobe.setPet(this.slot === 'pm' ? 'mount' : this.slot === 'p3' ? 'atk' : 'pick', row.id); else Wardrobe.pick(row); }));
      button.className = 'wardrobe-item'; button.title = title + '\n' + row.code; button.setAttribute('aria-label', 'Wear ' + title);
      const c = Wardrobe.cfg(), selected = pet ? c.pet[this.slot === 'pm' ? 'mount' : this.slot === 'p3' ? 'atk' : 'pick'] : c[targetSlot[0] === 'e' ? 'eq' : 'av'][Number(targetSlot.slice(1))]?.ref;
      button.setAttribute('aria-pressed', String(selected === row.id));
      const icon = el('span', null, 'slot skill-icon'); icon.append(el('span', pet ? 'Pet' : 'Skin', 'fallback')); Icons.paint(icon, Items.iconDdj(row.id));
      button.append(icon, el('span', title + (this.slot === 'a*' ? ' · ' + wdAvatarName(row.av) : ''))); grid.append(button);
    }
    const previous = UI.button('Previous skins', () => { this.page = Math.max(0, this.page - 1); this.results(parent); }), next = UI.button('Next skins', () => { this.page = Math.min(pages - 1, this.page + 1); this.results(parent); });
    previous.disabled = this.page === 0; next.disabled = this.page >= pages - 1;
    parent.append(grid, UI.row(previous, next));
    if (!rows.length) parent.append(el('p', 'No compatible skins match these filters.', 'muted'));
  },
};


// Native reinforce only. Never resend an unconfirmed material-spending request.
const Alchemy = {
  windowOwner: null, selected: null, run: null, pending: null, result: null, message: 'Select a bag weapon to begin.', started: false,
  cfg() { return Settings.profile.alchemy; },
  weapon(i) { return i && i.slot >= 13 && i.slot <= 255 && (i.typeFlags & 0x7e) === 0x2c && ((i.typeFlags >>> 7) & 15) === 6 && Number.isInteger(i.plus) && i.plus >= 0; },
  degree(i) { const n = i?.tooltip?.fields?.itemClass; return Number.isInteger(n) && n > 0 ? Math.floor((n - 1) / 3) + 1 : 0; },
  // Retail itemdata: weapon recipes 3675/3679 (param1 includes category 6).
  // Powder A 3683..3694 and B 3695..3706 have param1 = degree 1..12.
  elixir(i) { return i && [3675, 3679].includes(i.refObjId) && (i.typeFlags & 0xfffe) === 0x0d6c && i.quantity > 0 && i.slot >= 13; },
  powderDegree(i) {
    if (!i || (i.typeFlags & 0xfffe) !== 0x156c || !(i.quantity > 0) || i.slot < 13) return 0;
    return i.refObjId >= 3683 && i.refObjId <= 3694 ? i.refObjId - 3682 : i.refObjId >= 3695 && i.refObjId <= 3706 ? i.refObjId - 3694 : 0;
  },
  fingerprint(i) { return JSON.stringify([i.slot, i.refObjId, i.typeFlags, i.plus, i.durability, i.variance, i.magic]); },
  identity(i) { return JSON.stringify([i.slot, i.refObjId, i.typeFlags, i.variance]); },
  select(slot) {
    if (this.run || this.pending) return UI.toast('Stop alchemy and wait for the pending result before changing weapons.', 'warn');
    const item = World.items().find(i => i.slot === Number(slot));
    this.selected = this.weapon(item) ? { slot: item.slot, fingerprint: this.fingerprint(item) } : null;
    this.message = this.selected ? 'Weapon selected. Set the target and attempt limit.' : 'Select a bag weapon to begin.';
  },
  item() { return World.items().find(i => i.slot === this.selected?.slot); },
  materials(item, cfg = this.cfg()) {
    const elixir = World.items().find(i => this.elixir(i) && (!cfg.elixir || i.refObjId === cfg.elixir));
    const powder = cfg.powder ? World.items().find(i => this.powderDegree(i) === this.degree(item) && this.degree(item) > 0) : null;
    return { elixir, powder };
  },
  blocked() {
    if (BuffGear.run || BuffGear.recovery) return 'Restore or review combat gear before alchemy.';
    const gp = World.gp;
    if (!World.inWorld() || !gp || !World.local()) return 'Enter the game world first.';
    if (World.isDead()) return 'Alchemy stopped: character died.';
    if (Hunt.running || Town.trip || WalkBack.active || Restock.trip || Restock.recording || Resurrect.trip || Controller.resumeAfterRevive) return 'Stop hunting, travel and route recording first.';
    if (Loot.active) return 'Stop collection and wait for its inventory transaction first.';
    if (World.isCasting() || Hunt.underAttack() || gp.returnScroll || gp.pendingMoves) return 'Wait for combat and movement to finish.';
    if (Restock.activeShop() || gp.storage || gp.exchange?.open || gp.exchange?.requesting || gp.stall?.phase && gp.stall.phase !== 'none') return 'Close shop, storage, trade and stall first.';
    return '';
  },
  start() {
    if (this.run) return;
    if (this.pending) return UI.toast('Previous attempt is unconfirmed. Wait for its result; reload if the game cannot settle it.', 'warn');
    const error = this.blocked(), gp = World.gp, item = this.item(), c = this.cfg();
    const reject = text => { this.message = text; UI.toast(text, 'warn'); };
    if (error) return reject(error);
    if (gp.inventoryPending || !gp.alchemy || gp.alchemy.pending) return reject('Wait for known, settled inventory and alchemy state.');
    if (!this.weapon(item) || this.fingerprint(item) !== this.selected?.fingerprint) return reject('Weapon changed or moved. Select it again.');
    if (!Number.isInteger(c.target) || c.target < 1 || c.target > 250 || !Number.isInteger(c.limit) || c.limit < 1 || c.limit > 1000) return reject('Set target + from 1 to 250 and attempts from 1 to 1000.');
    if (item.plus >= c.target) return reject('Weapon already meets the target +.');
    const materials = this.materials(item);
    if (!materials.elixir) return reject('No selected weapon elixirs in the bag.');
    if (c.powder && !this.degree(item)) return reject('Weapon degree is unknown; cannot choose compatible lucky powder.');
    if (c.powder && !materials.powder) return reject('No lucky powder matching this weapon degree.');
    this.run = { slot: item.slot, identity: this.identity(item), fingerprint: this.fingerprint(item),
      cfg: { ...c }, config: JSON.stringify(c), manualAt: Manual.lastAt, character: World.charName,
      attempts: 0, successes: 0, failures: 0, elixirs: 0, powders: 0, nextAt: now(), opening: null };
    this.result = this.run; this.message = 'Preparing alchemy.';
  },
  stop(reason = 'Alchemy stopped. An attempt already sent may still finish.') {
    if (this.run) { this.run = null; this.message = reason; }
    // Close only a session we opened/used, on the same character. Native close
    // does not cancel reinforcement; keep the pending result until confirmed.
    const owner = this.windowOwner; this.windowOwner = null;
    if (owner && owner.character === World.charName && World.inWorld() && World.gp?.alchemy?.mode === 'reinforce')
      Cmd.raw({ kind: 'alchemy-close' }, 'Close alchemy');
  },
  init() {
    if (this.started) return; this.started = true;
    // All manual native gameplay commands can interfere with the selected bag.
    // Our own Cmd.raw bypasses these observers, as with combat/manual pause.
    Hook.observers.push(command => { if (command.kind === 'gameplay' && this.run) this.stop('Alchemy stopped by manual game control.'); });
    bus.on('game-error', text => { if (this.run && /alchemy|inventory process/i.test(String(text))) this.stop('Alchemy stopped after a game refusal; wait for the inventory to settle.'); });
    bus.on('reset', () => { this.windowOwner = null; this.stop('Alchemy stopped after world reset.'); this.pending = null; this.selected = null; });
  },
  observe() {
    const p = this.pending, gp = World.gp, a = gp?.alchemy;
    if (!p || !a || gp === p.state) return;
    if (a.pending) {
      if (a.mode !== 'reinforce' || a.slot !== p.run.slot) this.stop('Alchemy state changed unexpectedly. Wait for the outstanding result.');
      return;
    }
    if (a !== p.before && a.error !== null && a.error !== undefined) {
      this.pending = null; this.stop('Alchemy refused by the game (code ' + a.error + ').'); return;
    }
    const outcome = a.flags & 0x70;
    if (a.mode !== 'reinforce' || a.slot !== p.run.slot || ![0x10, 0x20, 0x40].includes(outcome) || gp.inventoryPending) return;
    // The worker may publish the start and result between our ticks. Require
    // exactly one of each selected reagent consumed, not just a stale flag.
    if (Restock.count(p.elixir.ref) !== p.elixir.before - 1 || p.powder && Restock.count(p.powder.ref) !== p.powder.before - 1) return;
    const item = World.items().find(i => i.slot === p.run.slot);
    if (outcome !== 0x40 && (!this.weapon(item) || this.identity(item) !== p.run.identity)) {
      this.stop('Weapon identity changed. Outstanding result requires manual review.'); return;
    }
    if (outcome === 0x40 && item) { this.stop('Unexpected destruction result. Outstanding result requires manual review.'); return; }
    if (outcome === 0x10 && item.plus !== p.plus + 1 || outcome === 0x20 && item.plus > p.plus) {
      this.stop('Unexpected enhancement level. Outstanding result requires manual review.'); return;
    }
    this.pending = null;
    p.run.elixirs++; if (p.powder) p.run.powders++;
    if (outcome === 0x10) p.run.successes++; else p.run.failures++;
    if (outcome === 0x40) { this.selected = null; this.stop('Weapon destroyed; alchemy stopped.'); this.message = 'Weapon destroyed; alchemy stopped.'; return; }
    p.run.fingerprint = this.fingerprint(item); this.selected = { slot: item.slot, fingerprint: p.run.fingerprint };
    p.run.nextAt = now() + 1000;
    if (this.run !== p.run) return;
    this.message = outcome === 0x10 ? 'Success: weapon is now +' + item.plus + '.' : 'Failed attempt: weapon is now +' + item.plus + '.';
    if (item.plus >= p.run.cfg.target) this.stop('Target reached: +' + item.plus + '.');
    else if (p.run.attempts >= p.run.cfg.limit) this.stop('Attempt limit reached.');
  },
  tick() {
    this.observe();
    const r = this.run, gp = World.gp;
    if (this.pending && now() - this.pending.at > 15000) this.stop('Result unconfirmed after 15 seconds. No further attempts; wait for settlement or reload.');
    if (!r || this.run !== r) return;
    const blocked = this.blocked();
    if (blocked || r.character !== World.charName || r.manualAt !== Manual.lastAt || r.config !== JSON.stringify(this.cfg())) return this.stop(blocked || 'Alchemy stopped: settings, character or manual control changed.');
    if (this.pending) { this.message = 'Attempt ' + r.attempts + ': waiting for server result.'; return; }
    const item = World.items().find(i => i.slot === r.slot);
    if (!this.weapon(item) || this.fingerprint(item) !== r.fingerprint) return this.stop('Weapon changed or moved. Select it again.');
    if (r.attempts >= r.cfg.limit || item.plus >= r.cfg.target) return this.stop('Target or attempt limit reached.');
    if (!gp.alchemy) return this.stop('Alchemy state unavailable.');
    if (gp.inventoryPending || gp.alchemy.pending || Loot.pressed()) { this.message = 'Alchemy waiting for inventory or potion use.'; return; }
    if (!gp.alchemy.visible) {
      if (r.opening !== null) { if (now() - r.opening > 5000) this.stop('Alchemy window did not open.'); return; }
      if (Cmd.spaced('alchemy-open') && Cmd.raw({ kind: 'alchemy-open' }, 'Open alchemy')) {
        r.opening = now(); this.windowOwner = { character: r.character };
      }
      return;
    }
    if (r.opening !== null) r.opening = null;
    if (now() < r.nextAt || !Cmd.spaced('alchemy-start')) return;
    const { elixir, powder } = this.materials(item, r.cfg);
    if (!elixir || r.cfg.powder && !powder) return this.stop('Selected elixirs or compatible lucky powder ran out.');
    const slots = [item.slot, elixir.slot, ...(powder ? [powder.slot] : [])];
    if (slots.some(slot => !Number.isInteger(slot) || slot < 13 || slot > 255) || new Set(slots).size !== slots.length) return this.stop('Invalid material slots.');
    if (Cmd.raw({ kind: 'alchemy-start', mode: 'reinforce', slots }, 'Alchemy: enhance selected weapon')) {
      this.windowOwner = { character: r.character };
      r.attempts++;
      this.pending = { run: r, state: gp, before: gp.alchemy, at: now(), plus: item.plus,
        elixir: { ref: elixir.refObjId, before: Restock.count(elixir.refObjId) },
        powder: powder ? { ref: powder.refObjId, before: Restock.count(powder.refObjId) } : null };
      this.message = 'Attempt ' + r.attempts + ': waiting for server result.';
    }
  },
  draw() {
    const c = () => this.cfg(), weapons = () => [[-1, 'Select a weapon from your bag'], ...World.items().filter(i => this.weapon(i)).map(i => [i.slot, (i.name || Items.name(i.refObjId)) + ' +' + i.plus + ' · bag slot ' + i.slot])];
    const group = UI.group('Weapon enhancement');
    group.append(UI.select('Weapon', weapons, () => this.selected?.slot ?? -1, slot => { this.select(slot); UI.draw(); }),
      UI.number('Target +', () => c().target, n => c().target = n, 1, 250),
      UI.number('Maximum attempts', () => c().limit, n => c().limit = n, 1, 1000),
      UI.select('Weapon elixir', () => [[0, 'Any compatible weapon elixir'], ...[...new Map(World.items().filter(i => this.elixir(i)).map(i => [i.refObjId, i.name || Items.name(i.refObjId)])).entries()]], () => c().elixir, value => c().elixir = Number(value)),
      UI.check('Use lucky powder of matching degree', () => c().powder, value => c().powder = value),
      UI.row(UI.button('Start alchemy', () => this.start()), UI.button('Stop alchemy', () => this.stop())),
      el('p', 'Keep the weapon in your bag and stop hunting/travel first. Each attempt spends a weapon elixir and, when enabled, matching lucky powder. Failures can reduce +, damage or destroy the weapon. Stop prevents the next attempt; a sent attempt may still finish. Unknown results pause without retrying.', 'muted'));
    UI.alchemyPreview = el('div', '', 'row'); UI.alchemyNote = el('p', '', 'muted'); group.append(UI.alchemyPreview, UI.alchemyNote); UI.pane.append(group);
    this.refresh();
  },
  refresh() {
    if (UI.current !== 'Alchemy' || !UI.alchemyNote) return;
    const item = this.item(), r = this.result;
    UI.alchemyNote.textContent = this.message + (r ? `\nAttempts ${r.attempts} · Success ${r.successes} · Failed ${r.failures} · Elixirs used ${r.elixirs} · Powder used ${r.powders}` : '') +
      `\nElixirs available: ${World.items().filter(i => this.elixir(i) && (!this.cfg().elixir || i.refObjId === this.cfg().elixir)).reduce((n, i) => n + i.quantity, 0)}` +
      (this.cfg().powder ? ` · Matching powder: ${World.items().filter(i => this.powderDegree(i) === this.degree(item) && this.degree(item) > 0).reduce((n, i) => n + i.quantity, 0)}` : '');
    const key = item ? item.refObjId + ':' + item.plus + ':' + item.slot : '';
    if (UI.alchemyPreview.dataset.item !== key) {
      UI.alchemyPreview.dataset.item = key; UI.alchemyPreview.replaceChildren();
      if (this.weapon(item)) {
        const icon = el('span', '', 'skill-icon'); Icons.paint(icon, item.icon || Items.iconDdj(item.refObjId));
        UI.alchemyPreview.append(icon, el('span', (item.name || Items.name(item.refObjId)) + ' +' + item.plus + (this.degree(item) ? ' · Degree ' + this.degree(item) : '')));
      }
    }
  },
};


// Explicit report fields only: never export raw logs, profiles or game snapshots.
const Diagnostics = {
  history: [], errors: [], last: '', started: false,
  number(value) { return Number.isFinite(value) ? value : null; },
  errorCode(message) {
    const text = String(message || '');
    for (const [pattern, code] of [
      [/Stale party join answer/i, 'stale-party-answer'],
      [/party matching.*pending/i, 'party-matching-pending'],
      [/(inventory|transaction).*pending|inventory.*busy/i, 'inventory-busy'],
      [/(bag|inventory).*(full|space|capacity)/i, 'bag-capacity'],
      [/COS ground|cos.pickup|pickup/i, 'pickup-error'],
      [/gold|money/i, 'insufficient-gold-or-payment'],
      [/scroll|return|travel/i, 'travel-error'],
      [/timeout|timed out/i, 'timeout'],
    ]) if (pattern.test(text)) return code;
    return 'unclassified-error';
  },
  start() {
    if (this.started) return;
    this.started = true;
    bus.on('game-error', text => this.error(text));
    bus.on('log', entry => { if (entry.level === 'error' || entry.level === 'warn') this.error(entry.text); });
  },
  error(text) {
    const code = this.errorCode(text), previous = this.errors[this.errors.length - 1];
    if (previous?.code === code && now() - previous.at < 1000) return;
    this.errors.push({ at: now(), code });
    if (this.errors.length > 12) this.errors.shift();
  },
  party() {
    const c = Settings.profile.party, m = World.gp?.partyMatching, s = World.gp?.social;
    if (!c.autoRecruit && !c.autoAcceptMatching) return 'Party automation off.';
    if (!World.inWorld() || !m || !s || !Array.isArray(s.members)) return 'Party: waiting for game state.';
    if (!m.request) return m.own ? 'Party: waiting for applicants.' : c.autoRecruit ? 'Party: waiting for listing registration.' : 'Party: listing missing.';
    if (s.leader && (!s.self || s.self !== s.leader) || !s.leader && s.members.length) return 'Party join blocked: you are not the leader.';
    const options = Party.options(m, s);
    if (!Number.isInteger(options)) return 'Party join blocked: sharing options unknown.';
    if (s.members.length >= ((options & 1) ? 8 : 4)) return 'Party join blocked: party full.';
    const sim = World.simNow(), r = m.request;
    if (!Number.isFinite(sim) || !Number.isFinite(r.expires)) return 'Party join blocked: clock or deadline unknown.';
    if (sim >= r.expires) return 'Party join blocked: request expired.';
    if (![r.a, r.b].every(id => Number.isInteger(id) && id > 0 && id <= 0xffffffff)) return 'Party join blocked: invalid request.';
    if (Party.answered === `${r.a}:${r.b}:${r.expires}`) return 'Party: acceptance sent; waiting for confirmation.';
    return 'Party: application ready for acceptance.';
  },
  pet() {
    if (!Hunt.cfg().pickup.enabled || !Loot.petMode()) return '';
    if (!Hunt.running) return 'Pet collection paused: bot stopped.';
    const pet = Loot.pet();
    if (!pet) return 'Pet waiting: summon a pickup pet.';
    if (!Number.isInteger(pet.rec.commandMode)) return 'Pet waiting for settings.';
    if (pet.rec.commandMode & 128) return 'Pet waiting for broad auto-grab to turn off.';
    if (World.gp?.inventoryPending) return 'Pet waiting for inventory transaction.';
    if (Loot.pressed()) return 'Pet waiting briefly for potion use.';
    if (Loot.active?.petGid) return Loot.active.retryAt ? 'Pet pickup: retry pending.' : 'Pet pickup: waiting for collection confirmation.';
    if (pet.rec.inventory.length >= pet.rec.status) return 'Pet bag full; only compatible stacks can merge.';
    return 'Pet ready; waiting for eligible drops. ' + this.noLoot();
  },
  // Why nothing is being collected, counted from the drops in view. Counts only, no item names.
  noLoot() {
    const why = { failed: 0, far: 0, area: 0, owner: 0, filter: 0, pet: 0, petFar: 0, full: 0 };
    let seen = 0, ready = 0;
    if (!World.pose()) return '';
    for (const e of World.ents.values()) {
      if (e.kind !== 'ground-item') continue;
      seen++;
      const reason = Loot.whyNot(e);
      if (reason) why[reason]++; else ready++;
    }
    if (!seen) return 'No drops in view.';
    const parts = [
      [why.filter, 'its type is switched off in Loot, or it is excluded by name, or SoX only is on'],
      [why.far, 'too far from you (Pickup radius)'],
      [why.area, 'outside the hunting area'],
      [why.owner, 'it belongs to another player'],
      [why.petFar, 'too far from the pet'],
      [why.pet, 'the pet is not ready'],
      [why.full, 'no room in the bag'],
      [why.failed, 'recently failed'],
    ].filter(([n]) => n).map(([n, text]) => `${n}: ${text}`);
    return `Drops in view: ${seen}, ready to collect: ${ready}.` + (parts.length ? ` Not collected: ${parts.join('; ')}.` : '');
  },
  town() {
    if (!Town.cfg().enabled) return '';
    if (Town.trip) return '';
    if (!Hunt.running) return '';
    const blocked = Town.blocked();
    if (blocked) return 'Town return blocked: ' + blocked + '.';
    const c = Town.cfg();
    if (['arrival', 'vendor', 'smith', 'gate', ...(c.petFull ? ['storage'] : [])].some(role => !c[role])) return 'Town return blocked: save missing service points in Supplies.';
    if (!Town.scroll(0x09ec)) return 'Town return blocked: return scroll missing.';
    if (!Town.scroll(0x19ec)) return 'Town return blocked: reverse scroll missing.';
    if (Town.validate()) return 'Town return blocked: check refill targets, low-stock thresholds and gold.';
    return Town.reason() ? 'Town return: preparing departure.' : '';
  },
  // What the town trip is doing right now, in plain words (no names): the phase text it shows on the panel.
  townDetail() { return Town.trip ? String(Town.message || '').slice(0, 200) : ''; },
  // Why no monster is being attacked, counted from the monsters in view with the same checks the hunt uses.
  // Counts only, no names. Short plain sentences, because the panel and diagnostics are read by many languages.
  noTarget() {
    const H = Hunt.cfg(), pose = World.pose();
    if (!pose) return '';
    const sim = World.simNow() ?? 0, include = splitList(H.include), exclude = splitList(H.exclude);
    const why = { banned: 0, kind: 0, level: 0, name: 0, far: 0, others: 0 };
    let seen = 0;
    for (const e of World.ents.values()) {
      if (!isAttackableMob(e)) continue;
      seen++;
      const name = (e.name || '').toLowerCase(), level = e.level ?? 0;
      if (Hunt.banned(Hunt.ban, e.gid)) why.banned++;
      else if (!Hunt.classAllowed(e)) why.kind++;
      else if (H.levelMin && level < H.levelMin || H.levelMax && level > H.levelMax) why.level++;
      else if (include.length && !include.some(s => name.includes(s)) || exclude.some(s => name.includes(s))) why.name++;
      else if (!Hunt.inArea(e) || dist2D(pose, e) > H.chase) why.far++;
      else if (H.avoidKs && sim - (World.hitByOthers.get(e.gid) ?? -Infinity) < 8000 && sim - (World.hitByUs.get(e.gid) ?? -Infinity) > 8000) why.others++;
    }
    if (!seen) return 'No monsters in view. Move to a place with monsters and press "Set hunting spot here".';
    const parts = [
      [why.kind, 'monster type is switched off (Combat > Hunt area > Monster classes)'],
      [why.level, 'level is outside your minimum or maximum level'],
      [why.name, 'name is not in "Only these mobs" or is in "Skip these mobs"'],
      [why.far, 'too far (Hunt radius or Chase distance)'],
      [why.others, 'another player is fighting it'],
      [why.banned, 'recently given up (blocked or cannot be selected)'],
    ].filter(([n]) => n).map(([n, text]) => `${n}: ${text}`);
    return `Monsters in view: ${seen}. Skipped: ${parts.join('; ') || 'none'}.`;
  },
  main() {
    if (BuffGear.run) return BuffGear.run.restoring ? 'Buff gear: restoring combat equipment.' : 'Buff gear: swapping or casting.';
    if (BuffGear.recovery) return 'Buff gear: manual equipment review needed.';
    if (Alchemy.pending) return Alchemy.run ? 'Alchemy: waiting for the server result.' : 'Alchemy stopped; outstanding result unconfirmed.';
    if (Alchemy.run) return 'Alchemy: preparing the next attempt.';
    if (Reconnect.active() && Reconnect.message && !World.inWorld()) return Reconnect.message;
    if (!World.inWorld()) return 'Waiting for game world.';
    if (World.isDead()) return 'Character dead; waiting for recovery.';
    if (Town.trip) {
      if (Town.trip.phase === 'buy') return Town.trip.supplies.map(s => `Refilling ${s.kind === 'hp' ? 'HP' : s.kind === 'mp' ? 'MP' : 'abnormal pills'}: ${Restock.count(s.refObjId)} / ${s.target}`).join(' · ');
      if (World.gp?.inventoryPending) return 'Town services: waiting for inventory transaction.';
      const phases = { recall: 'stopping combat for recall', 'recall-wait': 'waiting for recall arrival', 'reverse-wait': 'waiting for reverse arrival', 'revive-arrival': 'waiting for town revival', store: 'depositing loot', sell: 'selling pet loot', repair: 'repairing equipment', reverse: 'opening reverse return' };
      if (/^(walk|open)-/.test(Town.trip.phase) && Town.message) return Town.message;
      return 'Town services: ' + (phases[Town.trip.phase] || 'travelling between or opening services') + '.';
    }
    if (WalkBack.active || Restock.trip || Resurrect.trip) return 'Travelling; waiting to reach the destination.';
    if (!Hunt.running) return 'Bot stopped.';
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return 'Hunting paused after manual control.';
    if (Restock.activeShop() || World.gp?.storage) return 'Hunting paused: close shop or storage.';
    if (Hunt.state === 'resting' || Hunt.state === 'standing') return 'Recovering HP / MP.';
    if (Hunt.state === 'player') return 'Hunting paused by nearby-player setting.';
    if (Hunt.state === 'loot') return 'Character collecting; waiting for pickup confirmation.';
    if (World.isCasting()) return 'Combat: waiting for the current cast.';
    if (Hunt.state === 'fight' && Combat.fallbackNote()) return 'Combat: normal attack (' + Combat.fallbackNote() + ').';
    if (Hunt.targetGid) return 'Combat: approaching or attacking the target.';
    return 'Hunting: searching for an eligible target. ' + this.noTarget();
  },
  snapshot() {
    const gp = World.gp, c = Settings.profile, pet = Loot.pet(), social = gp?.social, matching = gp?.partyMatching;
    return {
      action: this.main(), partyStatus: this.party(), petStatus: this.pet(), townStatus: this.town(), townDetail: this.townDetail(),
      navigationReady: !!Navigation.scene, navigationError: String(Navigation.error || '').slice(0, 80),
      buffGearActive: !!BuffGear.run, buffGearRestoring: !!BuffGear.run?.restoring, buffGearMovePending: !!BuffGear.run?.pending, buffGearRecovery: !!BuffGear.recovery,
      alchemyActive: !!Alchemy.run, alchemyPending: !!Alchemy.pending, alchemyAttempts: this.number(Alchemy.result?.attempts),
      alchemyTarget: this.number(Alchemy.run?.cfg.target), alchemySuccesses: this.number(Alchemy.result?.successes),
      alchemyFailures: this.number(Alchemy.result?.failures), alchemyElixirsUsed: this.number(Alchemy.result?.elixirs),
      alchemyPowdersUsed: this.number(Alchemy.result?.powders), alchemyResultFlags: this.number(gp?.alchemy?.flags),
      alchemyError: this.number(gp?.alchemy?.error), alchemyWindowVisible: !!gp?.alchemy?.visible,
      nativeAlchemyPending: !!gp?.alchemy?.pending,
      nativeAlchemyMode: ['reinforce', 'attribute', 'magic', 'compound', 'advanced', 'dissolve'].includes(gp?.alchemy?.mode) ? gp.alchemy.mode : null,
      movementPending: !!gp?.pendingMoves, returnScrollActive: !!gp?.returnScroll,
      running: !!Hunt.running, inWorld: World.inWorld(), dead: World.isDead(),
      inventoryPending: !!gp?.inventoryPending, casting: World.isCasting(),
      curePills: Restock.count(58), freeBagSlots: this.number(World.freeBagSlots()), hpPotions: Potion.count('hp'), mpPotions: Potion.count('mp'),
      petFreeSlots: pet ? this.number(pet.rec.status - pet.rec.inventory.length) : null,
      pickupPending: !!Loot.active, pickupRetry: !!Loot.active?.retryAt, pickupAttempts: this.number(Loot.active?.attempts),
      petSetupAttempts: this.number(Loot.petSetup?.attempts), speedScrollPending: !!SpeedScroll.pending,
      speedScrollAttempts: this.number(SpeedScroll.attempts),
      partyMembers: this.number(social?.members?.length), partyOptions: this.number(social?.options),
      partyLeader: !!social?.self && social.self === social.leader, ownListing: !!matching?.own,
      matchingStateKnown: !!matching, simulationClockKnown: Number.isFinite(World.simNow()),
      matchingPending: ['page', 'join', 'register', 'modify', 'delete'].includes(matching?.pending) ? matching.pending : null,
      matchingResult: this.number(matching?.result), registrationPending: !!Party.registration,
      joinRequest: !!matching?.request, acceptanceSent: !!matching?.request && Party.answered === `${matching.request.a}:${matching.request.b}:${matching.request.expires}`,
      requestRemainingMs: Number.isFinite(World.simNow()) && Number.isFinite(matching?.request?.expires) ? Math.max(0, matching.request.expires - World.simNow()) : null,
      townActive: !!Town.trip,
      townPhase: ['recall', 'recall-wait', 'revive-arrival', 'walk-storage', 'open-storage', 'store', 'close-storage', 'walk-vendor', 'open-vendor', 'buy', 'close-vendor', 'walk-smith', 'open-smith', 'sell', 'repair', 'close-smith', 'walk-gate', 'open-gate', 'reverse', 'reverse-wait'].includes(Town.trip?.phase) ? Town.trip.phase : null,
      scrollAttempts: this.number(Town.trip?.scrollAttempts), scrollAccepted: !!Town.trip?.scrollRequest?.accepted,
      returnScroll: !!Town.scroll(0x09ec), reverseScroll: !!Town.scroll(0x19ec),
      settings: { autoRecruit: !!c.party.autoRecruit, autoAccept: !!c.party.autoAcceptMatching,
        townCycle: !!Town.cfg().enabled, revive: !!Town.cfg().revive, petFullReturn: !!Town.cfg().petFull,
        walkingRestock: !!Restock.cfg().enabled, buyHP: !!Restock.cfg().hp.on, buyMP: !!Restock.cfg().mp.on,
        hpTarget: this.number(Restock.cfg().hp.target), mpTarget: this.number(Restock.cfg().mp.target),
        buyCure: !!Restock.cfg().cure.on, cureTarget: this.number(Restock.cfg().cure.target), cureLow: this.number(Restock.cfg().cure.low),
        hpLow: this.number(Restock.cfg().hp.low), mpLow: this.number(Restock.cfg().mp.low),
        collectDrops: !!c.hunt.pickup.enabled, petCollector: Loot.petMode(), pickupRadius: this.number(c.hunt.pickup.radius / 10),
        finishFight: !!c.hunt.pickup.afterKillOnly, speedScroll: !!c.potion.speedScroll }
    };
  },
  sample() {
    try {
      const state = this.snapshot();
      // Deadline countdown alone is not a new state transition.
      const key = JSON.stringify({ ...state, requestRemainingMs: null });
      if (key !== this.last) { this.last = key; this.history.push({ at: now(), state }); }
      if (this.history.length > 30) this.history.shift();
      return state;
    } catch { return { action: 'Waiting for complete game state.' }; }
  },
  lines(state) {
    return [state.action, Settings.profile.party.autoRecruit || Settings.profile.party.autoAcceptMatching ? state.partyStatus : '', state.petStatus,
      state.townStatus].filter(Boolean).join('\n');
  },
  report() {
    const current = this.sample(), relative = entries => entries.map(({ at, ...entry }) => ({ secondsAgo: Math.max(0, Math.round((now() - at) / 1000)), ...entry }));
    return JSON.stringify({ app: 'OpenSRO Bot', version: VERSION,
      privacy: 'Names, chat, account details, locations and raw logs are omitted. Error categories replace original messages.',
      current, recentStates: relative(this.history), recentErrors: relative(this.errors) }, null, 2);
  },
  async copy() {
    const text = this.report();
    try {
      await W.navigator.clipboard.writeText(text);
      UI.toast('Bot diagnostics copied.');
    } catch { UI.showDiagnostics(text); }
  },
};


function el(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  node.className = className;
  return node;
}
const UI = {
  root: null, body: null, pane: null, status: null, feedback: null,
  current: 'Combat', combatTab: 'Skills', refreshers: [], lastSkillKey: '',
  toast(message, level = 'info', ms = 5000) {
    Log.add(level, message);
    if (!this.feedback) return;
    this.feedback.textContent = message;
    this.feedback.style.color = level === 'warn' || level === 'error' ? '#ffc67a' : '#b5e5bd';
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { if (this.feedback) this.feedback.textContent = ''; }, ms);
  },
  showDiagnostics(text) {
    if (!this.diagnosticBox) {
      this.diagnosticBox = this.group('Diagnostics', el('p', 'Clipboard unavailable. Select and copy this local status summary.', 'muted'));
      this.diagnosticText = el('textarea'); this.diagnosticText.readOnly = true; this.diagnosticText.rows = 8;
      this.diagnosticText.setAttribute('aria-label', 'Bot diagnostics');
      this.diagnosticBox.append(this.diagnosticText, this.button('Close diagnostics', () => { this.diagnosticBox.hidden = true; }));
      this.body.insertBefore(this.diagnosticBox, this.waitNote.nextSibling);
    }
    this.diagnosticBox.hidden = false; this.diagnosticText.value = text;
    this.diagnosticText.focus(); this.diagnosticText.select();
    this.toast('Clipboard unavailable—copy the selected diagnostics.');
  },
  // A draggable in-page window in the panel's skin. Lives in the same shadow root, so typing is protected like the panel.
  windowFrame(title, onClose, ...children) {
    const win = el('section', null, 'panel dialog'), header = el('header');
    const close = this.button('×', onClose); close.className = 'fold'; close.setAttribute('aria-label', 'Close ' + title.toLowerCase());
    header.append(el('strong', title), close);
    const body = el('div', null, 'body dialog-body'); body.append(...children);
    for (const corner of ['lu', 'mu', 'ru', 'ls', 'rs', 'ld', 'md', 'rd']) win.append(el('div', null, 'frame ' + corner));
    win.append(header, body);
    this.dragBy(header, win);
    return win;
  },
  // Keep a floating window fully on screen after a resize or when it is re-shown.
  fitWindow(win) {
    if (!win || win.hidden) return;
    const r = win.getBoundingClientRect();
    win.style.left = clamp(r.left, 0, Math.max(0, innerWidth - r.width)) + 'px';
    win.style.top = clamp(r.top, 0, Math.max(0, innerHeight - r.height)) + 'px';
  },
  dragBy(header, target) {
    header.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const start = target.getBoundingClientRect(), origin = { x: e.clientX, y: e.clientY };
      header.setPointerCapture(e.pointerId);
      const move = event => {
        target.style.right = 'auto';
        target.style.left = clamp(start.left + event.clientX - origin.x, 0, Math.max(0, innerWidth - start.width)) + 'px';
        target.style.top = clamp(start.top + event.clientY - origin.y, 0, Math.max(0, innerHeight - 34)) + 'px';
      };
      const done = () => { header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', done); header.removeEventListener('pointercancel', done); };
      header.addEventListener('pointermove', move); header.addEventListener('pointerup', done); header.addEventListener('pointercancel', done);
    });
  },
  button(text, action) {
    const b = el('button', text);
    b.type = 'button';
    b.addEventListener('click', () => { try { action(); } catch (e) { this.toast(e.message, 'warn'); } });
    return b;
  },
  row(...nodes) { const r = el('div', null, 'row'); r.append(...nodes); return r; },
  field(title, input) { const label = el('label', null, 'field'); input.setAttribute('aria-label', title); label.append(el('span', title), input); return label; },
  check(title, get, set) {
    const input = el('input'); input.type = 'checkbox'; input.checked = !!get();
    input.addEventListener('change', () => { set(input.checked); Settings.saveProfile(); });
    this.refreshers.push(() => { if (this.root?.activeElement !== input) input.checked = !!get(); });
    return this.field(title, input);
  },
  number(title, get, set, min, max, step = 1) {
    const input = el('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = get();
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) { input.value = get(); return; }
      const valid = clamp(Math.round(value / step) * step, min, max);
      input.value = valid; set(valid); Settings.saveProfile();
    });
    return this.field(title, input);
  },
  text(title, get, set, placeholder = 'comma-separated names') {
    const input = el('input'); input.type = 'text'; input.value = get(); input.placeholder = placeholder;
    input.addEventListener('change', () => { set(input.value); Settings.saveProfile(); });
    return this.field(title, input);
  },
  select(title, options, get, set) {
    const input = el('select');
    const refresh = () => {
      if (this.root?.activeElement === input) return;
      const rows = typeof options === 'function' ? options() : options;
      const signature = JSON.stringify(rows);
      if (input.dataset.options !== signature) {
        input.replaceChildren(...rows.map(([value, text]) => { const o = el('option', text); o.value = value; return o; }));
        input.dataset.options = signature;
      }
      input.value = String(get());
    };
    refresh(); this.refreshers.push(refresh);
    input.addEventListener('change', () => { set(input.value); Settings.saveProfile(); });
    return this.field(title, input);
  },
  group(title, ...children) { const b = el('fieldset'); b.append(el('legend', title), ...children); return b; },
  toggleVisibility() {
    const host = this.root?.host;
    if (host) host.hidden = !host.hidden;
  },
  mount() {
    const host = el('div'); host.id = 'sro-bot-lean';
    document.documentElement.append(host);
    this.root = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = ':host{' + Object.entries(LEAN_SKIN).map(([key, data]) => `--s-${key}:url("${data}");`).join('') + '}\n' + LEAN_CSS + '\n:host([hidden]){display:none!important}';
    const panel = el('section', null, 'panel'), header = el('header');
    const fold = this.button('−', () => { this.body.hidden = !this.body.hidden; fold.textContent = this.body.hidden ? '+' : '−'; });
    fold.className = 'fold'; fold.setAttribute('aria-label', 'Fold or unfold bot window');
    header.title = 'Shift+F7 hides or shows the whole window; F7 folds it.';
    header.append(el('strong', 'OpenSRO Bot ' + VERSION), fold);
    this.body = el('div', null, 'body'); this.status = el('div', 'Waiting for game…', 'status'); this.status.setAttribute('role', 'status');
    const controls = this.row(this.button('Start / stop · F8', () => toggleBot()), this.button('Return & hunt', () => WalkBack.start(true)), this.button('Stop all', () => stopAll()));
    controls.classList.add('controls');
    this.nav = el('nav'); this.nav.setAttribute('aria-label', 'Bot settings');
    for (const name of ['Combat', 'Loot', 'Supplies', 'Alchemy', 'Wardrobe', 'Settings']) this.nav.append(this.button(name, () => { this.current = name; this.draw(); }));
    this.pane = el('div', null, 'pane'); this.feedback = el('div', null, 'feedback'); this.feedback.setAttribute('role', 'status');
    this.waitNote = el('div', '', 'waiting'); this.waitNote.setAttribute('role', 'status');
    this.body.append(this.status, this.waitNote, controls, this.nav, this.pane, this.feedback);
    for (const corner of ['lu', 'mu', 'ru', 'ls', 'rs', 'ld', 'md', 'rd']) panel.append(el('div', null, 'frame ' + corner));
    panel.append(header, this.body); this.root.append(style, panel);
    this.tip = el('div', null, 'skill-tip'); this.tip.hidden = true; this.root.append(this.tip);
    this.dragBy(header, host);
    this.draw(); this.update();
  },
  skillOptions() {
    return [[0, 'Choose a learned skill'], ...(World.gp?.skills || []).map(id => World.skill(id)).filter(s => s && !s.groundTarget).map(s => [s.id, s.name || '#' + s.id])];
  },
  skillDetails(id) {
    const s = World.skill(id);
    if (!s) return 'Skill #' + id;
    return `Lv ${s.level ?? '?'} · MP ${s.mp ?? 0}${s.mpPercent ? ' + ' + s.mpPercent + '%' : ''} · CD ${((s.cooldownMs || 0) / 1000).toFixed(1)}s`;
  },
  skillTip(id, event) {
    const s = World.skill(id);
    if (!s || !this.tip) return;
    this.tip.replaceChildren(el('strong', s.name || '#' + id), el('div', this.skillDetails(id)), el('div', s.groundTarget ? 'Ground-target attack skill' : s.targetRequired ? 'Target skill' : 'Self skill', 'muted'));
    this.tip.hidden = false;
    const rect = event.currentTarget.getBoundingClientRect();
    this.tip.style.left = clamp(event.clientX || rect.left, 4, Math.max(4, innerWidth - 274)) + 'px';
    this.tip.style.top = clamp((event.clientY || rect.bottom) + 16, 4, Math.max(4, innerHeight - 100)) + 'px';
  },
  skillSlot(id, action, label, selected = false, order = '') {
    const s = World.skill(id);
    const slot = this.button('', action); slot.className = 'slot' + (selected ? ' on' : '');
    slot.dataset.skill = String(id); slot.setAttribute('aria-label', label || World.skillName(id));
    slot.setAttribute('aria-pressed', String(selected));
    slot.title = `${World.skillName(id)}\n${this.skillDetails(id)}`;
    slot.append(el('span', (s?.name || '#' + id).slice(0, 3), 'fallback'), el('span', '', 'cd'), el('span', '', 'seconds'));
    if (order !== '') slot.append(el('span', order, 'order'));
    Icons.paint(slot, s?.icon);
    slot.addEventListener('pointerenter', e => this.skillTip(id, e));
    slot.addEventListener('focus', e => this.skillTip(id, e));
    slot.addEventListener('pointerleave', () => { this.tip.hidden = true; });
    slot.addEventListener('blur', () => { this.tip.hidden = true; });
    return slot;
  },
  learnedSkills(buff) {
    const best = new Map();
    for (const s of Learned.rows()) {
      const iceField = isFrostNovaIceField(s);
      if (s.missing || (!iceField && s.active === false) || (s.groundTarget && !iceField) || (buff ? iceField || s.targetRequired : !iceField && (!s.targetRequired || (s.targets !== undefined && !(s.targets & 4))))) continue;
      const group = s.group ?? s.id, key = (iceField ? 'ice-field:' : 'group:') + group, previous = best.get(key);
      if (!previous || (s.level ?? 0) > (previous.level ?? 0)) best.set(key, s);
    }
    return [...best.values()];
  },
  skillList(parent, list, buff = false) {
    const strip = el('div', null, 'grid');
    list.forEach((entry, i) => {
      const id = Combat.resolve(entry) || entry.id;
      strip.append(this.skillSlot(id, () => { list.splice(i, 1); Settings.saveProfile(); this.draw(); }, 'Remove ' + World.skillName(id), true, String(i + 1)));
    });
    parent.append(el('div', buff ? 'Active buffs — click a slot to remove' : 'Attack order — click a slot to remove', 'muted'), strip);
    if (!list.length) parent.append(el('div', buff ? 'No buffs selected. Choose from the icons below.' : 'No skills selected. Choose from the icons below.', 'empty'));
    list.forEach((entry, i) => {
      const id = Combat.resolve(entry) || entry.id;
      const info = el('div', null, 'skill-info'); info.append(el('span', World.skillName(id), 'skill-name'), el('span', this.skillDetails(id), 'skill-detail'));
      const row = el('div', null, 'skill-row');
      const up = this.button('↑', () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; Settings.saveProfile(); this.draw(); } });
      const down = this.button('↓', () => { if (i + 1 < list.length) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; Settings.saveProfile(); this.draw(); } });
      const remove = this.button('×', () => { list.splice(i, 1); Settings.saveProfile(); this.draw(); });
      up.className = down.className = remove.className = 'mini';
      up.setAttribute('aria-label', 'Move up ' + World.skillName(id)); down.setAttribute('aria-label', 'Move down ' + World.skillName(id)); remove.setAttribute('aria-label', 'Delete ' + World.skillName(id));
      row.append(this.skillSlot(id, () => {}, World.skillName(id)), info, up, down, remove); parent.append(row);
      if (buff) parent.append(this.select('Gear for ' + World.skillName(id),
        () => [[0, 'Current combat gear'], ...Settings.profile.macro.buffSets.map(s => [s.id, s.name])],
        () => entry.gearSet || 0, value => entry.gearSet = Number(value)));
    });
    const search = el('input'); search.type = 'search'; search.placeholder = 'Find a skill…'; search.setAttribute('aria-label', buff ? 'Search buff skills' : 'Search attack skills');
    const title = el('div', null, 'picker-title'); title.append(el('span', buff ? 'Learned self buffs' : 'Learned attack skills'), search);
    const grid = el('div', null, 'grid'); grid.setAttribute('aria-label', buff ? 'Buff skill icons' : 'Attack skill icons');
    for (const s of this.learnedSkills(buff)) {
      const iceField = isFrostNovaIceField(s), group = s.group ?? s.id;
      const sameSkill = entry => entry.group === group && (iceField ? entry.iceField || isFrostNovaIceField(entry.id) : !entry.iceField && !isFrostNovaIceField(entry.id));
      const selected = list.some(sameSkill);
      const slot = this.skillSlot(s.id, () => {
        const index = list.findIndex(sameSkill);
        if (index >= 0) list.splice(index, 1);
        else list.push({ id: s.id, group, ...(iceField ? { iceField: true } : {}), ...(buff ? { enabled: true, mode: 'hunt', refreshS: 3 } : {}) });
        Settings.saveProfile(); this.draw();
      }, (selected ? 'Unselect ' : 'Add ') + World.skillName(s.id), selected);
      slot.dataset.search = ((s.name || '') + ' ' + s.level).toLowerCase(); grid.append(slot);
    }
    search.addEventListener('input', () => { for (const slot of grid.children) slot.hidden = !slot.dataset.search.includes(search.value.toLowerCase()); });
    parent.append(title, grid, el('p', 'Hover an icon for its name, level, MP and cooldown. Click to select; gold borders mark selected skills.', 'muted'));
    if (!grid.children.length) parent.append(el('div', 'No matching learned skills yet. Enter the game or reload if attached late.', 'empty'));
  },
  imbuePicker(parent) {
    const current = Settings.profile.macro.imbue;
    const grid = el('div', null, 'grid');
    const selected = current && (World.bestOfGroup(current.group, current.id) || current.id);
    parent.append(el('p', selected ? 'Selected: ' + World.skillName(selected) + ' · ' + this.skillDetails(selected) : 'No weapon imbue selected.', 'muted'));
    parent.append(this.button('No imbue', () => { Settings.profile.macro.imbue = null; Settings.saveProfile(); this.draw(); }));
    for (const s of this.learnedSkills(true)) grid.append(this.skillSlot(s.id, () => {
      Settings.profile.macro.imbue = { id: s.id, group: s.group ?? s.id };
      Settings.saveProfile(); this.draw();
    }, 'Use imbue ' + World.skillName(s.id), current?.group === (s.group ?? s.id)));
    parent.append(grid, el('p', 'Choose your weapon imbue here (for example Thunderdragon Force). The highest learned level in each group is shown and used automatically.', 'muted'));
  },
  draw() {
    if (!this.pane) return;
    if (this.tip) this.tip.hidden = true;
    this.lastSkillKey = this.skillKey();
    // Rebuilding the pane resets scrolling; keep the position when redrawing the same view.
    const view = [this.current, this.combatTab, this.rotationClass].join('|'), scroll = view === this.drawnView ? this.pane.scrollTop : 0;
    this.drawnView = view;
    this.refreshers = []; this.pane.replaceChildren();
    [...this.nav.children].forEach(b => b.setAttribute('aria-selected', String(b.textContent === this.current)));
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    if (this.current === 'Combat') {
      const subtabs = el('div', null, 'subtabs');
      for (const name of ['Skills', 'Buffs & imbue', 'Hunt area']) {
        const tab = this.button(name, () => { this.combatTab = name; this.draw(); });
        tab.setAttribute('aria-selected', String(name === this.combatTab)); subtabs.append(tab);
      }
      this.pane.append(subtabs);
      if (this.combatTab === 'Hunt area') {
      this.pane.append(this.group('Hunting area',
        this.button('Set hunting spot here', () => { if (World.inWorld() && Hunt.setCenter()) this.toast('Hunting spot saved.'); }),
        this.number('Hunt radius (m)', () => H().radius / 10, v => H().radius = v * 10, 5, 200),
        this.number('Chase distance (m)', () => H().chase / 10, v => H().chase = v * 10, 10, 300),
        this.check('Return when idle', () => H().returnToCenter, v => H().returnToCenter = v),
        this.check('Avoid other players’ targets', () => H().avoidKs, v => H().avoidKs = v),
        this.number('Minimum mob level (0 = any)', () => H().levelMin, v => H().levelMin = v, 0, 140),
        this.number('Maximum mob level (0 = any)', () => H().levelMax, v => H().levelMax = v, 0, 140),
        this.text('Only these mobs', () => H().include, v => H().include = v),
        this.text('Skip these mobs', () => H().exclude, v => H().exclude = v)
      ));
      const classes = this.group('Monster classes');
      for (const key of Object.keys(H().classes)) classes.append(this.check(key === 'titan' ? 'titan (uses Unique rotation)' : key, () => H().classes[key], v => H().classes[key] = v));
      this.pane.append(classes);
      }
      if (this.combatTab === 'Skills') {
      this.rotationClass ||= 'normal';
      const classes = el('div', null, 'class-tabs');
      for (const key of CLASS_KEYS) {
        const tab = this.button('', () => { this.rotationClass = key; this.draw(); });
        tab.setAttribute('aria-label', 'Rotation for ' + key); tab.setAttribute('aria-selected', String(key === this.rotationClass));
        const icon = el('i'); icon.style.backgroundImage = `var(--s-tw_${key})`;
        tab.append(icon, el('span', key)); classes.append(tab);
      }
      const rotation = this.group('Attack rotation', classes,
        this.check('Empty classes use Normal rotation', () => M().fallbackToNormal, v => M().fallbackToNormal = v),
        this.check('Use normal attacks', () => M().normalAttack, v => M().normalAttack = v));
      this.skillList(rotation, M().rotations[this.rotationClass]); this.pane.append(rotation);
      this.pane.append(this.group('Combat options',
        this.number('Skill gap (ms)', () => M().castGapMs, v => M().castGapMs = v, 150, 2000, 50)));
      this.pane.append(this.group('Berserk when the gauge is full, on',
        ...[['giant', 'Giants'], ['titan', 'Titans'], ['unique', 'Uniques'], ['elite', 'Elites'], ['party', 'Party monsters'], ['champion', 'Champions'], ['normal', 'Normal monsters']]
          .map(([key, label]) => this.check(label, () => M().berserkClasses[key], v => M().berserkClasses[key] = v))));
      }
      if (this.combatTab === 'Buffs & imbue') {
      BuffGear.draw(this.pane);
      const buffs = this.group('Buffs'); this.skillList(buffs, M().buffs, true);
      this.pane.append(buffs);
      const imbue = this.group('Weapon imbue'); this.imbuePicker(imbue); this.pane.append(imbue);
      }
    } else if (this.current === 'Loot') {
      const L = () => H().pickup;
      const options = this.group('Collection');
      options.append(this.select('Collector', [['character', 'Character'], ['pet', 'Pickup pet']], () => L().collector, v => { L().collector = v; Loot.reset(); }),
);
      options.append(this.check('Chime when pet bag is full', () => L().petFullSound, v => { L().petFullSound = v; Loot.fullAlert = null; }), this.button('Test pet chime', () => Sound.test()),
        this.check('Chime and notice when a SoX item is picked up', () => L().soxSound, v => L().soxSound = v), this.button('Test SoX chime', () => Sound.test('sox')));
      this.petNote = el('p', '', 'muted'); options.append(this.petNote);
      options.append(this.row(...[['Elixirs only','elixirs'],['Elixirs + gold','elixirs-gold'],['All items','all']].map(([label,mode]) => this.button(label, () => { Loot.preset(mode); this.draw(); }))));
      for (const [key, label] of [['enabled', 'Collect drops'], ['soxOnly', 'Equipment: only SoX (Star / Moon / Sun)'], ['gold', 'Gold'], ['potions', 'Potions and cure pills'], ['equipment', 'Equipment'], ['elixirs', 'Elixirs'], ['powders', 'Lucky powders'], ['magicStones', 'Magic stones (stored in the warehouse)'], ['attrStones', 'Attribute stones (stored in the warehouse)'], ['alchemy', 'Other alchemy items'], ['others', 'Other items'], ['afterKillOnly', 'Finish current fight before character pickup']]) options.append(this.check(label, () => L()[key], v => L()[key] = v));
      options.append(this.number('Pickup radius (m)', () => L().radius / 10, v => L().radius = v * 10, 3, 100),
        this.number('Retries after first attempt', () => L().retries, v => L().retries = v, 0, 3),
        this.text('Always include names', () => L().include, v => L().include = v),
        this.text('Exclude names', () => L().exclude, v => L().exclude = v),
        el('p', 'Pets collect during combat regardless of the finish-fight setting. Inventory transactions and potion priority can briefly delay pet requests. Equipment: only SoX takes Star, Moon and Sun gear and leaves plain equipment, even when Equipment or an Always include name matches it; other items follow their own switches. It needs the item catalogue, which loads automatically. Presets clear Always include names; exclusions still apply. Other items excludes the separate categories above. Ownership and bag capacity always apply. Failed pickups use a backoff.', 'muted'));
      this.pane.append(options);
    } else if (this.current === 'Supplies') {
      const pots = this.group('Automatic potion use', this.check('Use potions automatically', () => P().enabled, v => P().enabled = v));
      this.speedNote = el('p', '', 'muted');
      pots.append(this.check('Use beginner +100% speed scroll automatically', () => P().speedScroll, v => { P().speedScroll = v; SpeedScroll.reset(); }),
        el('p', 'Uses only the beginner scroll during hunting or travel when no movement-speed buff is active. Works during combat casts; potions have priority. Waits for buff confirmation and stops retrying after three unconfirmed attempts.', 'muted'), this.speedNote);
      for (const kind of ['hp', 'mp']) pots.append(this.check('Use ' + kind.toUpperCase(), () => P()[kind].on, v => P()[kind].on = v), this.number(kind.toUpperCase() + ' below (%)', () => P()[kind].pct, v => P()[kind].pct = v, 5, 95));
      pots.append(this.check('Use vigor potions', () => P().vigor.on, v => P().vigor.on = v),
        this.number('Vigor when HP below (%)', () => P().vigor.hpPct, v => P().vigor.hpPct = v, 0, 95),
        this.number('Vigor when MP below (%)', () => P().vigor.mpPct, v => P().vigor.mpPct = v, 0, 95),
        this.check('Use cure pills', () => P().cure.on, v => P().cure.on = v),
        this.check('Use recovery kits on my pets', () => P().petHp.on, v => { P().petHp.on = v; PetPotion.reset(); }),
        this.number('Pet HP below (%)', () => P().petHp.pct, v => P().petHp.pct = v, 5, 95),
        el('p', 'Pets: when an attack or pickup pet drops below this HP, one recovery kit (the smallest that covers the missing HP) is used on it. Your own potions always go first; each kit must be seen consumed before the next. Vigor potions need no setting beyond the two thresholds above; they are used only when the HP and MP potions are not enough.', 'muted'));
      this.petPotionNote = el('p', PetPotion.message, 'muted'); pots.append(this.petPotionNote);
      this.pane.append(pots);
      const townOn = Town.cfg().enabled;
      const shop = this.group('Potion restock');
      if (townOn) shop.append(el('p', 'The town cycle is on: every trip buys X-Large potions at the saved merchant, so walking-route restock and merchant recording are hidden. Low-stock and refill amounts below still apply.', 'muted'));
      else shop.append(this.check('Auto buy while hunting', () => C().enabled, v => C().enabled = v),
        this.row(this.button('Record from merchant', () => Restock.beginRecording()), this.button('Finish at hunt spot', () => Restock.finishRecording()), this.button('Cancel route', () => Restock.cancelRecording())),
        el('p', 'Open the potion shop, start recording, close the shop, walk to your hunting spot, then finish recording. Do not teleport while recording.', 'muted'));
      for (const kind of ['hp', 'mp']) {
        shop.append(this.check('Buy ' + kind.toUpperCase(), () => C()[kind].on, v => C()[kind].on = v));
        if (!townOn) shop.append(this.select(kind.toUpperCase() + ' potion', () => [[0, 'Record a merchant route first'], ...C().offers.filter(o => o.kind === kind).map(o => [o.refObjId, o.name])], () => C()[kind].refObjId, v => C()[kind].refObjId = Number(v)));
        shop.append(this.number('Low stock ≤', () => C()[kind].low, v => C()[kind].low = v, 0, 9999), this.number(kind.toUpperCase() + ' refill to', () => C()[kind].target, v => C()[kind].target = v, 1, 10000));
      }
      shop.append(this.check('Buy vigor potions', () => C().vigor.on, v => C().vigor.on = v),
        this.select('Vigor potion size', [[18, 'Herb (smallest)'], [19, 'Small'], [20, 'Medium'], [21, 'Large'], [22, 'X-Large']], () => C().vigor.refObjId, v => C().vigor.refObjId = Number(v)),
        this.number('Vigor low stock ≤', () => C().vigor.low, v => C().vigor.low = v, 0, 9999),
        this.number('Vigor refill to', () => C().vigor.target, v => C().vigor.target = v, 1, 10000),
        el('p', 'Vigor potions use the size you pick here on every town trip and walking restock. Pick a size the potion merchant sells, or the trip stops with a message. Using them is set under Automatic potion use.', 'muted'),
        this.check('Buy abnormal pills (best)', () => C().cure.on, v => C().cure.on = v),
        this.number('Pills low stock ≤', () => C().cure.low, v => C().cure.low = v, 0, 9999),
        this.number('Pills refill to', () => C().cure.target, v => C().cure.target = v, 1, 10000),
        el('p', 'Buys only Special Universal Pill (small), the strongest universal cure. No cheaper substitute. Uses the same refill trips as HP/MP. Use cure pills above controls automatic use.', 'muted'));
      shop.append(el('p', 'Refill targets are total potion counts, including what is already in your bag. Used for low-supply, full-bag and revival trips, and walking-route restock when the town cycle is off. Set MP refill to 1000 for 1,000 MP potions. Changes apply to the next trip.', 'muted'));
      this.pane.append(shop);
      const town = () => Town.cfg();
      const services = this.group('Scroll town cycle',
        this.check('Use return scroll → town services → reverse return', () => town().enabled, v => { town().enabled = v; this.draw(); }),
        this.check('Revive in town and reverse to last scroll point', () => town().revive, v => town().revive = v),
        this.check('Deposit SoX gear in the warehouse (character and pet bags)', () => town().storeSox, v => town().storeSox = v),
        this.text('Also deposit gear requiring level', () => town().storeLevels, v => town().storeLevels = v, 'e.g. 85 or 80-90, 100'),
        this.check('Return when pickup pet is nearly full', () => town().petFull, v => town().petFull = v),
        this.number('Pet free slots ≤', () => town().petFree, v => town().petFree = v, 0, 10),
        this.number('Town arrival tolerance (m)', () => town().arrivalRadius / 10, v => town().arrivalRadius = v * 10, 10, 150),
        el('p', 'Bind your recall to Hotan, Jangan, Donwhang, Constantinople or Samarkand in the game. Quickest: while stopped, use a return scroll and press Auto-set town services where it puts you; it fills the arrival point and the four services. To do it by hand instead, save the arrival point where a return scroll places you, then stand near, select and save the warehouse, potion merchant, repair merchant and world statue / teleport. Open the potion shop before saving its merchant. Saves your standing position for each approach. Uses collision-aware walking between services. Overrides the recorded walking restock while enabled.', 'muted'));
      for (const [role, label] of [['arrival', 'Arrival point'], ['storage', 'Warehouse'], ['vendor', 'Potion merchant'], ['smith', 'Repair merchant'], ['gate', 'World statue / teleport']]) services.append(
        this.row(this.button('Save ' + label.toLowerCase(), () => Town.save(role)), el('span', town()[role]?.name || (town()[role] ? 'Saved' : 'Not saved'), 'muted')));
      services.append(this.button('Auto-set town services', () => Town.autoSetup(false)), this.button('Redo all automatically', () => Town.autoSetup(true)));
      services.append(el('p', 'Pet loot: store elixirs, and Star / Moon / Sun gear when SoX deposit is on (needs the saved warehouse; SoX gear in your own bag goes in too, all other character items stay). Nothing is deposited right after pickup, only on the next town trip. Gear requiring one of the levels you list above (for example 85) is deposited the same way and never sold. SoX gear that is part of a saved buff set, the weapon chosen for alchemy, or matches the Keep names stays in your bag. Sell other unprotected pet items at the saved weapon / repair merchant before repairing. Other seal/rare equipment and equipment with unknown rarity stays in the pet. Ordinary equipment is sold regardless of + or blue options. Existing character bag items are never sold.', 'muted'));
      services.append(this.text('Keep in pet (names)', () => town().keep, v => town().keep = v),
        el('p', 'Town buys X-Large potions using the Buy HP/MP switches, low-stock thresholds and refill counts above. Keep each low-stock threshold below its refill target. Potion selections apply to walking-route restock. Returns when the character bag has at most one free slot. Free at least two slots before hunting again; existing character items stay protected. Revival uses the saved town services and a reverse scroll, without using a return scroll in town. Pet loot passes through one reserved character bag slot. Potions, return/reverse scrolls, beginner speed scrolls and matching Keep names are protected. Refills travel scrolls to two where sold for gold; otherwise carry spares. F8 cancels.', 'muted'));
      this.townNote = el('p', Town.status(), 'muted'); services.append(this.townNote); this.pane.append(services);
    } else if (this.current === 'Alchemy') {
      Alchemy.draw();
    } else if (this.current === 'Wardrobe') {
      LeanWardrobe.draw(this.pane);
    } else {
      Stats.draw(this.pane);
      this.pane.append(this.group('Behaviour',
        ...(Town.autoRevive() ? [el('p', 'On death: the town cycle revives you in town and reverses back (Supplies → Scroll town cycle).', 'muted')]
          : [this.select('On death', [['stop', 'Stop'], ['wait', 'Wait'], ['revive', 'Revive and walk back']], () => H().onDeath, v => H().onDeath = v)]),
        this.check('Rest when low', () => H().sit.enabled, v => { H().sit.enabled = v; this.draw(); }),
        ...(H().sit.enabled ? [
          this.number('Rest below HP (%)', () => H().sit.hpBelow, v => H().sit.hpBelow = v, 0, 95),
          this.number('Rest below MP (%)', () => H().sit.mpBelow, v => H().sit.mpBelow = v, 0, 95),
          this.number('Stand up at (%)', () => H().sit.resumeAt, v => H().sit.resumeAt = v, 30, 100)] : []),
        this.check('Stop when HP potions run out', () => H().stopNoHpPotion, v => H().stopNoHpPotion = v),
        this.check('Stop when bag is full', () => H().stopInvFull, v => H().stopInvFull = v),
        this.number('Manual control pause (s)', () => H().manualPauseS, v => H().manualPauseS = v, 1, 30)));
      this.stuckNote = el('p', AntiStuck.status(), 'muted');
      this.pane.append(this.group('Anti-stuck',
        this.check('Recover when hunting makes no progress', () => H().antiStuck.enabled, v => H().antiStuck.enabled = v),
        this.number('No progress for (minutes)', () => H().antiStuck.minutes, v => H().antiStuck.minutes = v, 1, 30),
        this.number('Stop after failed recoveries', () => H().antiStuck.maxRecoveries, v => H().antiStuck.maxRecoveries = v, 1, 10),
        this.stuckNote,
        el('p', 'Progress means a confirmed kill, XP, gold, a pickup, or damage to your target. Resting, buffing, looting, shopping and town trips do not count against you. First recovery drops the current target; the next ones walk back to the saved hunting spot; after the last one hunting stops.', 'muted')));
      const party = () => Settings.profile.party;
      this.partyNote = el('p', '', 'muted');
      this.pane.append(this.group('Party',
        this.check('Auto-recruit', () => party().autoRecruit, v => { party().autoRecruit = v; Party.reset(); }),
        this.text('Party listing title', () => party().title, v => party().title = v),
        this.number('Party minimum level', () => party().min, v => party().min = v, 1, 90),
        this.number('Party maximum level', () => party().max, v => party().max = v, 1, 90),
        this.select('Party purpose', [[0, 'Hunting'], [1, 'Quest'], [2, 'Trade'], [3, 'Thief']], () => party().purpose, v => party().purpose = Number(v)),
        this.check('Share EXP in new parties', () => party().expShare, v => party().expShare = v),
        this.check('Share items in new parties', () => party().itemShare, v => party().itemShare = v),
        this.partyNote,
        el('p', 'Auto-recruit registers your saved listing and accepts applicants whenever enabled, even with hunting stopped. Restores missing listings when space opens and retries unconfirmed registrations after fresh idle state, at most once every 30 seconds. Existing listings and party sharing settings are preserved; edits apply to the next new listing. Turning this off leaves the current listing in place.', 'muted'),
        this.check('Auto-accept party-matching joins', () => Settings.profile.party.autoAcceptMatching, v => Settings.profile.party.autoAcceptMatching = v),
        el('p', 'Accepts applications to your own listing while you are the leader or forming a new party. Works while hunting is stopped; turn this switch off to stop accepting. Ordinary invitations are left to you.', 'muted'),
        this.check('Accept resurrection from party members', () => party().acceptRes, v => party().acceptRes = v),
        el('p', 'When you are dead and a party member casts Rebirth on you, the bot answers Yes. Works during hunting and while stopped; resurrection offers from other players are left to you.', 'muted'),
        this.check('Auto-resurrect party members', () => party().autoRes, v => { party().autoRes = v; Resurrect.reset(); }),
        this.number('Maximum res distance from hunt spot (m)', () => party().resRadius / 10, v => party().resRadius = v * 10, 1, 100),
        el('p', 'Works during hunting and while stopped. Walks into skill range for visible dead members within the maximum radius, casts Rebirth, then returns. During hunting the radius is measured from the saved hunt spot; while stopped it uses your starting position. Collision data is required for walking. Travel stops after 30 seconds or 12 seconds without progress per leg. The member must accept the revival. Travel, shopping and manual control take priority.', 'muted')));
      AutoMastery.draw(this.pane);
      this.pane.append(this.group('Profiles', el('p', 'Settings are saved separately for each character.', 'muted'),
        this.button('Export OpenSRO Bot settings', () => {
          const url = URL.createObjectURL(new Blob([JSON.stringify({ app: 'sro-bot-lean', version: VERSION, profile: Settings.profile }, null, 2)], { type: 'application/json' }));
          const link = el('a'); link.href = url; link.download = 'opensro-bot-settings.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        })));
      this.pane.append(this.group('Diagnostics', el('p', 'Copies a small local status summary. Nothing is uploaded.', 'muted'), this.button('Copy diagnostics', () => { void Diagnostics.copy(); })));
      this.logs = el('pre'); this.pane.append(this.group('Recent activity', this.logs));
    }
    this.update();
    this.pane.scrollTop = scroll;
  },
  skillKey() {
    return (World.gp?.skills || []).map(id => { const s = World.skill(id); return `${id}:${s?.name}:${s?.icon}:${s?.level}`; }).join('|');
  },
  update() {
    Stats.sample(); Stats.render();
    Alchemy.refresh();
    if (this.current === 'Combat' && this.combatTab === 'Buffs & imbue' && BuffGear.note) BuffGear.note.textContent = BuffGear.status();
    const diagnosticState = Diagnostics.sample();
    if (this.waitNote) this.waitNote.textContent = Diagnostics.lines(diagnosticState);
    if (this.townNote) this.townNote.textContent = Town.status();
    if (this.current === 'Settings' && AutoMastery.note) AutoMastery.note.textContent = AutoMastery.status();
    if (this.current === 'Settings' && this.stuckNote) this.stuckNote.textContent = AntiStuck.status();
    if (this.current === 'Settings' && this.partyNote) {
      const notes = [Settings.profile.party.autoRecruit ? Party.message : 'Auto-recruit off.'];
      if (Settings.profile.party.autoRes) notes.push(Resurrect.message);
      this.partyNote.textContent = notes.join(' ');
    }
    if (!this.status) return;
    if (this.current === 'Supplies' && this.petPotionNote) this.petPotionNote.textContent = PetPotion.message;
    if (this.current === 'Supplies' && this.speedNote) this.speedNote.textContent = SpeedScroll.message;
    if (this.current === 'Loot' && this.petNote) { this.petNote.hidden = !Loot.petMode(); this.petNote.textContent = Loot.petStatus(); }
    Learned.repair();
    if (this.current === 'Combat' && this.lastSkillKey !== this.skillKey()) { this.draw(); return; }
    const me = World.me(), center = Settings.profile.hunt.center;
    const distance = center ? dist2D(World.pose(), center) : Infinity;
    this.status.textContent = `${World.charName || 'No character'} · ${World.inWorld() ? Controller.mode : World.phase}\nHP ${Math.round(me.hpPct)}% · MP ${Math.round(me.mpPct)}% · Potions ${Potion.count('hp')}/${Potion.count('mp')} · Pickups ${Stats.values.loot}\nHunting spot: ${Number.isFinite(distance) ? Math.round(distance / 10) + ' m away' : center ? 'another region' : 'not saved'}${Restock.recording ? '\nRecording route: ' + Restock.draft.route.length + ' points' : ''}`;
    if (Town.cfg().enabled) this.status.textContent += '\n' + Town.status();
    if (Reconnect.active() && Reconnect.message) this.status.textContent += '\n' + Reconnect.message;
    this.refreshers.forEach(refresh => refresh());
    for (const slot of this.pane.querySelectorAll('.slot[data-skill]')) {
      const id = Number(slot.dataset.skill), left = World.cooldownLeft(id), total = World.skill(id)?.cooldownMs || 0;
      slot.querySelector('.cd').style.setProperty('--p', total && left > 0 ? Math.min(100, left / total * 100) + '%' : '0%');
      slot.querySelector('.seconds').textContent = left > 0 ? String(Math.ceil(left / 1000)) : '';
    }
    if (this.current === 'Settings' && this.logs) this.logs.textContent = Log.lines.slice(-12).map(l => l.text).join('\n');
  },
};


function toggleBot() {
  if (Alchemy.run || Alchemy.pending || Hunt.running || Town.trip || WalkBack.active || Restock.trip || Resurrect.trip || Controller.resumeAfterRevive) stopAll();
  else if (Restock.recording) UI.toast('Finish or cancel route recording before starting the bot.', 'warn');
  else Hunt.start();
}

function boot() {
  UI.mount(); Stats.init(); Diagnostics.start();
  const unlockSound = e => {
    if (e.isTrusted && (Settings.profile.hunt.pickup.petFullSound || Settings.profile.hunt.pickup.soxSound)) Sound.unlock();
  };
  W.addEventListener('pointerdown', unlockSound, true);
  W.addEventListener('keydown', unlockSound, true);
  // The game listens globally and prevents bound keys even when a shadow-DOM
  // field owns focus. Stop propagation early, but retain native editing defaults.
  const protectEditing = e => {
    const path = e.composedPath(), target = path[0];
    if (path.includes(UI.root?.host) && (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || ''))) {
      e.stopImmediatePropagation();
    }
  };
  for (const type of ['keydown', 'keypress', 'keyup']) W.addEventListener(type, protectEditing, true);
  // Scrolling the panel must not also zoom or move the game camera underneath it.
  W.addEventListener('wheel', e => { if (e.composedPath().includes(UI.root?.host)) e.stopImmediatePropagation(); }, { capture: true, passive: true });
  Combat.init(); Loot.init(); Alchemy.init(); BuffGear.init();
  bus.on('character', name => {
    const key = name ? 'profile:' + name : 'profile:default';
    if (key !== Settings.profileKey) { Town.lastScrollPoint = null; stopAll(); Settings.useCharacter(name); }
  });
  bus.on('profile', () => { PetPotion.reset(); AutoMastery.reset(); BuffGear.reset(); Town.lastScrollPoint = null; SpeedScroll.reset(); Party.reset(); Resurrect.reset(); stopAll(); Restock.cancelRecording(); Loot.reset(); Wardrobe.applyNow(); UI.draw(); });
  bus.on('phase', phase => {
    if (phase !== 'world') {
      BuffGear.interrupt('World transition interrupted buff swaps.');
      Party.reset();
      SpeedScroll.reset();
      Resurrect.reset();
      if (Town.phase(phase)) { Loot.reset(); return; }
      const revival = phase === 'entering-world' && Hunt.running && (Town.autoRevive() || Hunt.cfg().onDeath === 'revive') && (Hunt.state === 'dead' || Hunt.revived);
      stopAll(); Restock.cancelRecording(); Loot.reset();
      Controller.resumeAfterRevive = revival;
    }
  });
  bus.on('failure', () => { BuffGear.interrupt('Connection failed during buff swaps.'); stopAll(); Restock.cancelRecording(); UI.toast('Game connection failed; bot stopped.', 'warn'); });
  bus.on('reset', () => {
    BuffGear.interrupt('World reset interrupted buff swaps.');
    if (Town.trip) {
      if (['recall-wait', 'reverse-wait'].includes(Town.trip.phase)) Town.trip.transition = true;
      else Town.fail('Unexpected world reset during town service.');
    }
    SpeedScroll.reset(); Party.reset(); Resurrect.reset(); Loot.reset(); Navigation.scene = null; Wardrobe.inv = Wardrobe.baseInv = Wardrobe.av = Wardrobe.baseAv = null; Wardrobe.body = '';
  });
  bus.on('attached', ({ late }) => { if (late) UI.toast('Attached after the game started. Reload for complete character data.', 'warn'); });
  bus.on('potion-empty', kind => UI.toast('Out of ' + kind.toUpperCase() + ' potions.', 'warn'));
  W.addEventListener('keydown', e => {
    if (!e.isTrusted || e.repeat || e.isComposing) return;
    const target = e.composedPath()[0];
    if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '')) return;
    if (e.code === 'F8') { e.preventDefault(); e.stopImmediatePropagation(); toggleBot(); }
    else if (e.code === 'F7') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.shiftKey) UI.toggleVisibility();
      else UI.body.hidden = !UI.body.hidden;
    }
  }, true);
  Ticker.start(() => Controller.tick(), 100);
  setInterval(() => { Wardrobe.tick(); UI.update(); }, 500);
  W.SROLean = { version: VERSION, stats: Stats, diagnostics: Diagnostics, alchemy: Alchemy, buffGear: BuffGear, world: World, settings: Settings, hunt: Hunt, loot: Loot, speedScroll: SpeedScroll, resurrect: Resurrect,
    restock: Restock, town: Town, walkBack: WalkBack, antiStuck: AntiStuck, autoMastery: AutoMastery, reconnect: Reconnect, petPotion: PetPotion, navigation: Navigation, wardrobe: Wardrobe, wardrobeData: WdData, learned: Learned, controller: Controller, stop: stopAll, log: Log };
  Log.info('OpenSRO Bot ready. F8 starts/stops; F7 folds; Shift+F7 hides/shows the window.');
}

installWorkerHook();
if (document.documentElement) boot();
else document.addEventListener('DOMContentLoaded', boot, { once: true });


})();
