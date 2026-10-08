import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    alignCaptionWords,
    assTime,
    buildWordAss,
    captionDisplayText,
    captionAnchor,
    captionStyleSize,
    cleanCaptionClock,
    ffmpegSubtitlesArg,
    googleLanguageCode,
    smoothFilterGraph,
    smoothFrameProgress,
    smoothPlan,
    youtubeHandoffNote,
} from '../server/unique-extra.js';

test('a full HD frame stays put, and a smaller frame or AI still uses the model', () => {
    assert.deepEqual(smoothPlan(1080, 1920), { engine: 'filter', scale: 1, outW: 1080, outH: 1920, modelW: 1080, modelH: 1920 });
    assert.deepEqual(smoothPlan(1920, 1080), { engine: 'filter', scale: 1, outW: 1920, outH: 1080, modelW: 1920, modelH: 1080 });
    assert.equal(smoothPlan(1080, 1920, 'ai').engine, 'model');
    assert.equal(smoothPlan(1080, 1920, 'ai').scale, 2);
    assert.deepEqual(smoothPlan(640, 360), { engine: 'model', scale: 3, outW: 640, outH: 360, modelW: 1920, modelH: 1080 });
    assert.deepEqual(smoothPlan(480, 854), { engine: 'model', scale: 3, outW: 480, outH: 854, modelW: 1440, modelH: 2562 });
    assert.equal(smoothPlan(720, 1280).engine, 'model');
    assert.equal(smoothPlan(720, 1280).scale, 2);
    assert.equal(smoothFilterGraph(1080, 1920), 'scale=1080:1920:flags=lanczos,hqdn3d=1.5:1:3:2,cas=0.4,setsar=1');
    assert.equal(smoothFrameProgress(0, 1200), 0);
    assert.ok(Math.abs(smoothFrameProgress(120, 1200) - 10) < 0.001);
    assert.equal(smoothFrameProgress(240, 1200), 20);
    assert.equal(smoothFrameProgress(1200, 1200), 99);
});

test('a YouTube handoff names the preset chosen on that tab', () => {
    assert.equal(youtubeHandoffNote({}), '');
    assert.equal(youtubeHandoffNote({ handoffFrom: 'youtube', handoffPreset: 'Nhe', presetName: 'Nhe' }), 'Từ YouTube. Preset “Nhe”.');
    assert.equal(youtubeHandoffNote({ handoffFrom: 'youtube' }), 'Từ YouTube. Không chọn preset bên YouTube.');
    assert.equal(
        youtubeHandoffNote({ handoffFrom: 'youtube', handoffPreset: 'Nhe', presetName: 'Khac' }),
        'Từ YouTube. Preset “Nhe” đã chọn bên YouTube. Lượt này dùng “Khac”.',
    );
    assert.equal(
        youtubeHandoffNote({ handoffFrom: 'youtube', handoffPreset: 'Nhe' }),
        'Từ YouTube. Preset “Nhe” đã chọn bên YouTube. Lượt này dùng công tắc đang mở.',
    );
});

test('whisper language becomes the Google tag, and an existing tag is kept', () => {
    assert.equal(googleLanguageCode('pt'), 'pt-BR');
    assert.equal(googleLanguageCode('en'), 'en-US');
    assert.equal(googleLanguageCode('vi'), 'vi-VN');
    assert.equal(googleLanguageCode('pt-BR'), 'pt-BR');
    assert.equal(googleLanguageCode(''), '');
    assert.equal(googleLanguageCode('xx'), 'xx');
});

test('a word that runs into the next one is cut back, and the text is lowercase', () => {
    const clock = cleanCaptionClock([
        { word: 'Lindês,', start: 0.54, end: 1.4 },
        { word: 'essa', start: 1.24, end: 1.3 },
    ]);
    assert.equal(clock[0].word, 'lindês');
    assert.equal(clock[0].start, 0.54);
    assert.equal(clock[0].end, 1.22);
    assert.equal(clock[1].word, 'essa');
});

test('Google spelling replaces only a similar beat and never moves the clock', () => {
    const clock = [
        { word: 'oi', start: 0.1, end: 0.4 },
        { word: 'lindês', start: 0.54, end: 0.96 },
        { word: 'essa', start: 1.0, end: 1.2 },
        { word: 'é', start: 1.2, end: 1.3 },
        { word: 'a', start: 1.3, end: 1.4 },
        { word: 'minha', start: 1.4, end: 1.7 },
        { word: 'bonita', start: 10.24, end: 10.76 },
        { word: 'eu', start: 15.46, end: 15.98 },
        { word: 'gosto', start: 15.98, end: 16.32 },
        { word: 'olha', start: 17.38, end: 17.64 },
        { word: 'aí', start: 17.64, end: 18.28 },
    ];
    const google = [
        { word: 'oi', start: 0.0, end: 0.5 },
        { word: 'lindeza', start: 0.5, end: 1.0 },
        { word: 'você', start: 1.0, end: 1.2 },
        { word: 'só', start: 1.2, end: 1.3 },
        { word: 'me', start: 1.3, end: 1.5 },
        { word: 'bonita', start: 7.6, end: 10.8 },
        { word: 'eu', start: 13.9, end: 16.5 },
        { word: 'gosto', start: 16.5, end: 16.6 },
    ];
    const cues = alignCaptionWords(clock, google);
    assert.deepEqual(cues.map((c) => [c.word, c.start, c.end]), [
        ['oi', 0.1, 0.4],
        ['lindeza', 0.54, 0.96],
        ['essa', 1.0, 1.2],
        ['é', 1.2, 1.3],
        ['a', 1.3, 1.4],
        ['minha', 1.4, 1.7],
        ['bonita', 10.24, 10.76],
        ['eu', 15.46, 15.98],
        ['gosto', 15.98, 16.32],
        ['olha', 17.38, 17.64],
        ['aí', 17.64, 18.28],
    ]);
    assert.deepEqual(cues.filter((c) => c.replaced).map((c) => c.word), ['lindeza']);
});

test('the Brazil listen keeps its clock and only changes lindês to lindeza', () => {
    const whisperPath = 'C:/Users/T15p/AppData/Local/Temp/phude-words.json';
    const googlePath = 'C:/Users/T15p/AppData/Local/Temp/phude-google-words.json';
    if (!fs.existsSync(whisperPath) || !fs.existsSync(googlePath)) return;
    const whisper = JSON.parse(fs.readFileSync(whisperPath, 'utf8')).words.map((w) => ({ word: w.w, start: w.s, end: w.e }));
    const google = JSON.parse(fs.readFileSync(googlePath, 'utf8')).words.map((w) => ({ word: w.w, start: w.s, end: w.e }));
    const cues = alignCaptionWords(whisper, google);
    assert.equal(cues.length, whisper.length);
    const changes = [];
    cues.forEach((cue, i) => {
        assert.equal(cue.start, whisper[i].start);
        assert.equal(cue.end, whisper[i].end);
        if (cue.word !== captionDisplayText(whisper[i].word)) changes.push([whisper[i].word, cue.word, cue.start]);
    });
    assert.deepEqual(changes, [['lindês', 'lindeza', 0.54]]);
    const bonita = cues.find((c) => c.word === 'bonita');
    assert.equal(bonita.start, 10.24);
    assert.equal(bonita.end, 10.76);
    assert.ok(cues.some((c) => c.word === 'olha' && c.start === 17.38));
});

test('a centred word cue uses the Brazil style, scaled to the frame', () => {
    assert.deepEqual(captionStyleSize(1440, 2562), { font: 150, outline: 16 });
    assert.deepEqual(captionStyleSize(1080, 1920), { font: 112, outline: 12 });
    const ass = buildWordAss({
        width: 1440,
        height: 2562,
        cues: [{ word: 'lindeza', start: 0.54, end: 0.96 }],
    });
    assert.match(ass, /PlayResX: 1440/);
    assert.match(ass, /PlayResY: 2562/);
    assert.match(ass, /Style: Word,Arial Black,150,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,16,0,5,40,40,0,1/);
    assert.equal(captionAnchor('middle', 1920).alignment, 5);
    assert.equal(captionAnchor('middle', 1920).marginV, 0);
    const bottom = buildWordAss({
        width: 1080,
        height: 1920,
        place: 'bottom',
        cues: [{ word: 'lindeza', start: 0.54, end: 0.96 }],
    });
    assert.match(bottom, /Style: Word,Arial Black,112,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,12,0,2,40,40,192,1/);
    assert.equal(captionAnchor('bottom', 1920).marginV, 192);
    assert.equal(captionAnchor('top', 1920).alignment, 5);
    assert.equal(captionAnchor('nope', 1920).alignment, 5);
    assert.match(ass, /Dialogue: 0,0:00:00\.54,0:00:00\.96,Word,,0,0,0,,lindeza/);
    assert.equal(assTime(65.2), '0:01:05.20');
    assert.equal(
        ffmpegSubtitlesArg('D:\\tool\\ghostforge-refactored\\uploads\\abc_cap.ass', 'C:\\Windows\\Fonts'),
        "subtitles='D\\:/tool/ghostforge-refactored/uploads/abc_cap.ass':fontsdir='C\\:/Windows/Fonts'",
    );
});
