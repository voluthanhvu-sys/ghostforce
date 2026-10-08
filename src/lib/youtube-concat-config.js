// Browser memory for which Unique preset and which Edit setup a channel, or a
// named chain of channels, should use after a concat. A channel's own setup
// wins over the chain.

import { normalizeEditProfile } from './edit-profile.js';

const CHANNEL_KEY = /^UC[A-Za-z0-9_-]{22}:(videos|shorts)$/;

export function emptyConcatConfig() {
  return { channels: {}, chains: {} };
}

export function readConcatConfig(raw) {
  const config = emptyConcatConfig();
  if (!raw || typeof raw !== 'object') return config;
  const chains = raw.chains && typeof raw.chains === 'object' ? raw.chains : {};
  for (const [id, row] of Object.entries(chains)) {
    if (!/^[a-z0-9]{8}$/.test(id) || !row || typeof row !== 'object') continue;
    const name = clipName(row.name);
    if (!name) continue;
    config.chains[id] = {
      name,
      presetId: clipId(row.presetId),
      edit: normalizeEditProfile(row.edit),
    };
  }
  const channels = raw.channels && typeof raw.channels === 'object' ? raw.channels : {};
  for (const [key, row] of Object.entries(channels)) {
    if (!CHANNEL_KEY.test(key) || !row || typeof row !== 'object') continue;
    const chainId = config.chains[row.chainId] ? row.chainId : '';
    config.channels[key] = {
      presetId: clipId(row.presetId),
      chainId,
      edit: normalizeEditProfile(row.edit),
    };
  }
  return config;
}

export function presetFor(config, channelKey) {
  const row = rowOf(config, channelKey);
  if (!row) return '';
  if (row.presetId) return row.presetId;
  return config.chains[row.chainId]?.presetId || '';
}

export function presetSource(config, channelKey) {
  const next = readConcatConfig(config);
  const row = rowOf(next, channelKey);
  if (!row) return { kind: 'none', presetId: '', chainName: '' };
  const chain = next.chains[row.chainId];
  const chainName = chain?.name || '';
  if (row.presetId) return { kind: 'channel', presetId: row.presetId, chainName };
  if (chain?.presetId) return { kind: 'chain', presetId: chain.presetId, chainName };
  return { kind: 'none', presetId: '', chainName };
}

export function editFor(config, channelKey) {
  const row = rowOf(config, channelKey);
  if (!row) return null;
  if (row.edit) return row.edit;
  return config.chains[row.chainId]?.edit || null;
}

export function findChain(config, name) {
  const next = readConcatConfig(config);
  const label = clipName(name).toLowerCase();
  if (!label) return null;
  return Object.values(next.chains).find((chain) => chain.name.toLowerCase() === label) || null;
}

export function chainNameFor(config, channelKey) {
  const row = rowOf(config, channelKey);
  if (!row?.chainId) return '';
  return config.chains[row.chainId]?.name || '';
}

export function saveChannelPreset(config, channelKey, presetId) {
  const next = readConcatConfig(config);
  const row = ensureChannel(next, channelKey);
  if (!row) return next;
  row.presetId = clipId(presetId);
  return next;
}

export function saveChannelEdit(config, channelKey, edit) {
  const next = readConcatConfig(config);
  const row = ensureChannel(next, channelKey);
  if (!row) return next;
  row.edit = normalizeEditProfile(edit);
  return next;
}

export function saveChainPreset(config, channelKey, name, presetId) {
  const next = readConcatConfig(config);
  const chain = ensureChain(next, channelKey, name);
  if (!chain) return next;
  chain.presetId = clipId(presetId);
  return next;
}

export function saveChainEdit(config, channelKey, name, edit) {
  const next = readConcatConfig(config);
  const chain = ensureChain(next, channelKey, name);
  if (!chain) return next;
  chain.edit = normalizeEditProfile(edit);
  return next;
}

function rowOf(config, channelKey) {
  if (!CHANNEL_KEY.test(String(channelKey || ''))) return null;
  return config?.channels?.[channelKey] || null;
}

function ensureChannel(config, channelKey) {
  if (!CHANNEL_KEY.test(String(channelKey || ''))) return null;
  if (!config.channels[channelKey]) config.channels[channelKey] = { presetId: '', chainId: '', edit: null };
  return config.channels[channelKey];
}

function ensureChain(config, channelKey, name) {
  const row = ensureChannel(config, channelKey);
  const label = clipName(name);
  if (!row || !label) return null;
  const found = Object.entries(config.chains).find(([, chain]) => chain.name.toLowerCase() === label.toLowerCase());
  const id = found ? found[0] : newChainId(config);
  if (!config.chains[id]) config.chains[id] = { name: label, presetId: '', edit: null };
  else config.chains[id].name = label;
  row.chainId = id;
  return config.chains[id];
}

function newChainId(config) {
  for (let n = 0; n < 20; n += 1) {
    const id = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
    if (!config.chains[id]) return id;
  }
  return `c${Date.now().toString(16)}`.slice(0, 8).padEnd(8, '0');
}

function clipId(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(text) ? text : '';
}

function clipName(value) {
  const text = String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, 40).join('').trim();
}
