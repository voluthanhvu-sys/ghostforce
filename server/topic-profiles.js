// Topic profiles: recognise the kind of video first, then apply that topic's
// rules - the operator's "square goes to the square template" idea, applied to
// BOTH the global plan (how the video is split into parts) and the per-part
// Detail pass (how the 9:16 frame is chosen). Pure: no I/O, unit tested.

export const TOPIC_KEYS = ['cops', 'animals', 'podcast', 'sports', 'gameplay', 'reaction', 'product', 'story', 'generic'];

const PROFILES = {
    cops: {
        label: 'Cops / bodycam / dashcam',
        addon: 'TOPIC = police, bodycam or dashcam footage. Split parts around one incident each: the approach, the confrontation, the pursuit, the arrest. Focus on the officer who is acting, or the suspect once they run. Use a top/bottom split only when a second person is far to the left or right and both matter at that moment. Otherwise stay on focus. There is no corner inset.',
    },
    animals: {
        label: 'Động vật / wildlife',
        addon: 'TOPIC = wildlife. Split parts around one hunt, chase, standoff or interaction. Focus on the animal that is acting. Use a top/bottom split only when a second animal is far apart horizontally and both matter at that moment. Otherwise stay on focus. Never aim at empty grass, sky or water. There is no corner inset.',
    },
    podcast: {
        label: 'Podcast / talkshow / phỏng vấn',
        addon: 'TOPIC = podcast, talk show or interview. Focus on whoever is speaking and switch to them when they speak. Use a top/bottom split only when both people are far apart horizontally and both carry that moment. A listener beside the speaker stays in the same focus crop. There is no corner inset.',
    },
    sports: {
        label: 'Thể thao',
        addon: 'TOPIC = sports. Split parts around plays and reactions, not around the clock. Focus on the ball or the player with it, and pan while the play runs. Use a top/bottom split only when a second subject is far apart horizontally and worth its own half. Otherwise stay on focus. There is no corner inset.',
    },
    gameplay: {
        label: 'Game / stream',
        addon: 'TOPIC = gameplay or stream. Focus on the game action. A small face camera in the corner is not a split. Use a top/bottom split only when the player face and the game are both large, far apart horizontally, and both matter. When the reaction is the whole point of that stretch, focus on the face instead.',
    },
    reaction: {
        label: 'Reaction / bình luận',
        addon: 'TOPIC = reaction or commentary. Focus on whichever of the content or the reacting face carries the moment, and switch when that changes. Use a top/bottom split only when the face and the content are both large, far apart horizontally, and both matter at once. Do not turn a small corner face into half the frame.',
    },
    product: {
        label: 'Sản phẩm / review / thử nghiệm',
        addon: 'TOPIC = product review, unboxing or testing. Focus on the host, and focus on the product when it is shown alone. Use a top/bottom split only when the host and a different on-screen event are far apart and both matter. Do not split to show the host beside the same product, the same person, or their hands.',
    },
    story: {
        label: 'Kể chuyện / phim / drama',
        addon: 'TOPIC = narrative or drama footage. Focus on the character who carries the beat. Use a top/bottom split only when a second character is far apart horizontally and their reaction matters at that same moment. Do not cut mid-line. Do not split just because another person is in the background.',
    },
    generic: {
        label: 'Chung',
        addon: '',
    },
};

const SYNONYMS = [
    [/police|cop|bodycam|dashcam|cảnh sát|canh sat|trấn áp|arrest/, 'cops'],
    [/animal|wildlife|động vật|dong vat|predator|safari|bird|thú/, 'animals'],
    [/podcast|talk ?show|interview|phỏng vấn|phong van|talkshow|debate/, 'podcast'],
    [/sport|bóng|bong|football|basketball|goal|match|thể thao|the thao/, 'sports'],
    [/game|gaming|gameplay|stream|twitch|minecraft|roblox/, 'gameplay'],
    [/reaction|react|commentary|bình luận|binh luan/, 'reaction'],
    [/product|review|unbox|sản phẩm|san pham|thử nghiệm|thu nghiem|gadget/, 'product'],
    [/story|drama|movie|phim|kể chuyện|ke chuyen|narrative/, 'story'],
];

// Any label the model invents is mapped onto a known key; unknown stays generic
// rather than guessing (the operator's "do not guess the topic" rule).
export const normalizeTopic = (raw) => {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return 'generic';
    if (TOPIC_KEYS.includes(value)) return value;
    for (const [pattern, key] of SYNONYMS) {
        if (pattern.test(value)) return key;
    }
    return 'generic';
};

export const topicProfile = (topic) => {
    const key = normalizeTopic(topic);
    return { key, label: PROFILES[key].label, addon: PROFILES[key].addon };
};

// Below this the model is not sure enough and the app keeps the generic profile
// instead of applying a workflow that may be wrong.
export const TOPIC_MIN_CONFIDENCE = 0.6;

export const resolveTopic = ({ topic, confidence } = {}, pinned = '') => {
    if (pinned) {
        const profile = topicProfile(pinned);
        if (profile.key !== 'generic') return { ...profile, confidence: 1, pinned: true };
    }
    const value = Number(confidence);
    const key = normalizeTopic(topic);
    const trusted = key !== 'generic' && (!Number.isFinite(value) || value >= TOPIC_MIN_CONFIDENCE);
    return trusted
        ? { ...topicProfile(key), confidence: Number.isFinite(value) ? value : null, pinned: false }
        : { ...topicProfile('generic'), confidence: Number.isFinite(value) ? value : null, pinned: false };
};

export const topicClassifierPrompt = () => `You label one video so an editor can pick the right workflow. You get a few stills from it, in order.
Return JSON only: {"topic":"cops","confidence":0.86}
topic is ONE short label from this list when it fits: cops, animals, podcast, sports, gameplay, reaction, product, story. Use "generic" only when none of them fits.
confidence is 0..1: how sure you are. Do not guess - a low confidence is better than a wrong label.`;
