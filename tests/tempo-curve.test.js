import test from 'node:test';
import assert from 'node:assert/strict';
import { commandLineLength, WINDOWS_COMMAND_BUDGET } from '../server/ffmpeg-expressions.js';
import { chunkTempoBranches, outputTimeAt, shapeForGain, TEMPO_SHAPE, tempoAudioChain, tempoCurve } from '../server/tempo-curve.js';

test('strong gain keeps the measured 8-second shape', () => {
    assert.deepEqual(shapeForGain(2), TEMPO_SHAPE);
    assert.ok(shapeForGain(2.8).every((value, i) => value === TEMPO_SHAPE[i]));
    assert.ok(Math.abs(shapeForGain(1)[0] - 1.075) < 1e-9);
});

test('output time matches the piecewise speeds used in the 8s check', () => {
    const at = outputTimeAt(2.5, TEMPO_SHAPE);
    assert.ok(Math.abs(at - 2.18556) < 0.001, String(at));
    assert.equal(outputTimeAt(0, TEMPO_SHAPE), 0);
});

test('video expression and audio commands describe the same speeds', () => {
    const curve = tempoCurve(1, 2, 8.008);
    assert.equal(curve.videoSetpts.replace(/\\,/g, '').includes(','), false);
    assert.match(curve.videoSetpts, /\\,/);
    assert.match(curve.audioChain, /atempo=1\.1500/);
    assert.match(curve.audioChain, /atempo=1\.1200/);
    assert.match(curve.audioChain, /concat=n=8:v=0:a=1/);
    assert.ok(Math.abs(curve.outputTimeAt(8) - 8.028887) < 0.002);
    assert.ok(Math.abs(curve.mapSpeed - 8 / curve.outputTimeAt(8)) < 0.001);
    assert.equal(tempoAudioChain(curve.branches), curve.audioChain);
});

test('a long tempo chain is split into the same branches under the command budget', () => {
    const curve = tempoCurve(1, 2, 400);
    const argv = ['-y', '-i', 'clip.mp4', '-af', curve.audioChain];
    assert.ok(commandLineLength(argv) > WINDOWS_COMMAND_BUDGET);
    assert.ok(curve.audioChain.length > 32767);
    const maxChain = WINDOWS_COMMAND_BUDGET - 2500;
    const chunks = chunkTempoBranches(curve.branches, maxChain);
    assert.ok(chunks.length > 1);
    assert.deepEqual(chunks.flat(), curve.branches);
    for (const chunk of chunks) {
        const chain = tempoAudioChain(chunk);
        assert.ok(chain.length <= maxChain);
        assert.match(chain, /atrim=start=/);
        assert.match(chain, /atempo=/);
    }
    const short = tempoCurve(1, 2, 8.008);
    assert.equal(chunkTempoBranches(short.branches, maxChain).length, 1);
});
