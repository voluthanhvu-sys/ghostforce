import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createNamedPreset,
    describeUniquePreset,
    readPresetList,
    rotatePartsFrom,
    updateNamedPreset,
} from '../src/lib/unique-presets.js';

const look = {
    platformMode: 'auto',
    uniqueStrength: 'strong',
    rotateMode: 'off',
    enableAdversarial: true,
    enableAudioAttack: false,
    enableTikTokCanvas: false,
    featherEnabled: false,
    featherTop: 12,
    featherBottom: 8,
    enableSmooth: true,
    enableCaptions: false,
    enablePgd: true,
    enablePgdOnly: false,
    pgdLevel: 'medium',
    encoderMode: 'nvidia',
};

test('describe lists every saved switch in panel language', () => {
    const lines = describeUniquePreset(look);
    assert.match(lines[0], /Làm mịn: BẬT, nhanh/);
    assert.match(lines[0], /giữ nguyên kích thước/);
    const aiLines = describeUniquePreset({ ...look, smoothMode: 'ai' });
    assert.match(aiLines[0], /Làm mịn: BẬT, AI/);
    assert.match(aiLines[0], /Mặt người có thể bị vẽ lại/);
    assert.equal(lines[1], 'Unique: chạy.');
    assert.match(lines.join('\n'), /Độ khác biệt: Mạnh — khác nguồn nhiều/);
    assert.match(lines.join('\n'), /Kiểu xoay: Tắt — không xoay/);
    assert.match(lines.join('\n'), /EQ tiếng mạnh: TẮT/);
    assert.match(lines.join('\n'), /PGD: Vừa\. CLIP ~0\.94-0\.97\. Chạy sau Unique\./);
    assert.match(lines.join('\n'), /Phụ đề: TẮT\. Bỏ qua\./);
    assert.match(lines.join('\n'), /Encoder: NVIDIA NVENC/);
});

test('pgd-only says Unique is skipped and still keeps the unique lines', () => {
    const lines = describeUniquePreset({ ...look, enablePgdOnly: true, enableSmooth: false, enableCaptions: true });
    assert.match(lines[0], /Làm mịn: TẮT/);
    assert.match(lines[1], /Unique: bỏ qua/);
    assert.match(lines.join('\n'), /Độ khác biệt: Mạnh/);
    assert.match(lines.join('\n'), /Chỉ PGD — bỏ toàn bộ Unique/);
    assert.match(lines.join('\n'), /Phụ đề: BẬT, giữa khung/);
    assert.match(describeUniquePreset({ ...look, enableCaptions: true, captionPlace: 'bottom' }).join('\n'), /Phụ đề: BẬT, dưới, cách mép dưới 10%/);
    assert.match(describeUniquePreset({ ...look, enableCaptions: true, captionPlace: 'top' }).join('\n'), /Phụ đề: BẬT, giữa khung/);
    assert.equal(createNamedPreset('Tren', { ...look, captionPlace: 'top' }, []).preset.settings.captionPlace, 'middle');
    assert.match(lines.join('\n'), /Google chỉ sửa chính tả/);
});

test('create rejects an empty name and a duplicate, and keeps the snapshot', () => {
    const first = createNamedPreset('  Preset 1  ', look, []);
    assert.equal(first.ok, true);
    assert.equal(first.preset.name, 'Preset 1');
    assert.equal(first.preset.settings.enableSmooth, true);
    assert.equal(first.preset.settings.pgdLevel, 'medium');
    const again = createNamedPreset('preset 1', look, [first.preset]);
    assert.equal(again.ok, false);
    assert.equal(again.error, 'Đã có tên này. Tạo tên khác.');
    assert.equal(createNamedPreset('   ', look, []).ok, false);
});

test('update overwrites the same preset and refuses another preset name', () => {
    const first = createNamedPreset('Preset 1', look, []);
    const second = createNamedPreset('Preset 2', { ...look, enableSmooth: false }, [first.preset]);
    const saved = updateNamedPreset(first.preset.id, 'preset 1', { ...look, enableCaptions: true }, [first.preset, second.preset]);
    assert.equal(saved.ok, true);
    assert.equal(saved.preset.id, first.preset.id);
    assert.equal(saved.preset.name, 'preset 1');
    assert.equal(saved.preset.settings.enableCaptions, true);
    const renamed = updateNamedPreset(first.preset.id, '  Preset 3  ', { ...look, enableSmooth: false }, [first.preset, second.preset]);
    assert.equal(renamed.ok, true);
    assert.equal(renamed.preset.id, first.preset.id);
    assert.equal(renamed.preset.name, 'Preset 3');
    assert.equal(renamed.preset.settings.enableSmooth, false);
    const clash = updateNamedPreset(first.preset.id, 'PRESET 2', look, [first.preset, second.preset]);
    assert.equal(clash.ok, false);
    assert.equal(clash.error, 'Đã có tên này. Tạo tên khác.');
    assert.equal(updateNamedPreset('gone', 'Moi', look, [first.preset]).ok, false);
});

test('read drops junk and a pgd-only flag cannot survive with PGD off', () => {
    const saved = createNamedPreset('A', { ...look, enablePgd: false, enablePgdOnly: true }, []);
    const list = readPresetList([saved.preset, { name: '', id: 'x' }, null, 'nope']);
    assert.equal(list.length, 1);
    assert.equal(list[0].settings.enablePgdOnly, false);
    assert.equal(list[0].settings.captionPlace, 'middle');
    assert.equal(list[0].settings.featherTop, 12);
});

test('rotate parts stay zero when the mode is off', () => {
    assert.deepEqual(rotatePartsFrom('off'), { rotate: 0, wobble: 0 });
    assert.deepEqual(rotatePartsFrom('tilt2'), { rotate: 2, wobble: 0 });
    assert.deepEqual(rotatePartsFrom('wob1'), { rotate: 0, wobble: 1 });
});
