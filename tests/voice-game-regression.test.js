const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function createElement(id = "") {
  const listeners = new Map();
  return {
    id,
    className: "",
    dataset: {},
    disabled: false,
    innerHTML: "",
    height: 640,
    style: {},
    textContent: "",
    width: 360,
    value: "",
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    classList: {
      add() {},
      contains() { return false; },
      remove() {},
      toggle() {},
    },
    getContext() {
      return new Proxy({}, {
        get(target, prop) {
          if (prop === "createLinearGradient") {
            return () => ({ addColorStop() {} });
          }
          if (!(prop in target)) target[prop] = () => {};
          return target[prop];
        },
        set(target, prop, value) {
          target[prop] = value;
          return true;
        },
      });
    },
  };
}

function loadGame() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((source) => source.trim());
  assert.equal(scripts.length, 1, "expected one inline game script");

  const expose = `
    window.__testApi = {
      state,
      player,
      bullets,
      enemies,
      gameOver,
      handleVoiceCommand,
      initRecognition,
      update,
      getRecognition: () => recognition,
    };
  })();`;
  const source = scripts[0].replace(/\}\)\(\);\s*$/, expose);
  assert.notEqual(source, scripts[0], "failed to expose game internals");

  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  const diffButtons = ["easy", "normal", "hard"].map((diff) => {
    const button = createElement(`diff-${diff}`);
    button.dataset.diff = diff;
    return button;
  });
  const storage = new Map();

  class MockRecognition {
    constructor() {
      this.continuous = false;
      this.interimResults = false;
      this.lang = "";
      this.maxAlternatives = 1;
    }
    abort() {
      if (this.onend) this.onend();
    }
    start() {
      if (this.onstart) this.onstart();
    }
  }

  class MockImage {
    set src(value) {
      this._src = value;
    }
  }

  class MockUtterance {
    constructor(text) {
      this.text = text;
    }
  }

  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => 1;

  const speechSynthesis = {
    latestUtterance: null,
    speaking: false,
    cancel() {
      this.speaking = false;
    },
    speak(utterance) {
      this.latestUtterance = utterance;
      this.speaking = true;
    },
  };

  const context = {
    console,
    document: {
      getElementById: getElement,
      querySelectorAll(selector) {
        return selector === ".diff-btn" ? diffButtons : [];
      },
    },
    Image: MockImage,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      removeItem(key) { storage.delete(key); },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    Math: deterministicMath,
    performance: { now: () => 10_000 },
    prompt: () => null,
    requestAnimationFrame: () => 0,
    setTimeout,
    clearTimeout,
    SpeechRecognition: MockRecognition,
    webkitSpeechRecognition: MockRecognition,
    SpeechSynthesisUtterance: MockUtterance,
    speechSynthesis,
  };
  context.window = context;
  context.window.addEventListener = () => {};

  vm.createContext(context);
  vm.runInContext(source, context, { filename: "index.inline.js" });

  return { api: context.__testApi, speechSynthesis, storage };
}

function finishLatestUtterance(speechSynthesis) {
  const utterance = speechSynthesis.latestUtterance;
  speechSynthesis.speaking = false;
  if (utterance && typeof utterance.onend === "function") utterance.onend();
}
test("final name saves the score immediately exactly once", () => {
  const { api, storage } = loadGame();
  api.state.scene = "gameover";
  api.state.score = 321;
  api.state.nameEntry = { candidate: "", waitingConfirm: false };
  api.state.replayPrompt = false;

  api.handleVoiceCommand("민수", {
    isFinal: true,
    resultIndex: 1,
    speechScene: "gameover",
  });

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "민수", score: 321 },
  ]);
  assert.equal(api.state.replayPrompt, true);
});

test("a delayed gameplay result cannot consume the game-over name slot", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 99;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  api.gameOver();
  recognition.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "뿅" }, isFinal: true }],
  });
  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);

  finishLatestUtterance(speechSynthesis);
  recognition.onspeechstart();
  recognition.onresult({
    resultIndex: 1,
    results: [
      { 0: { transcript: "뿅" }, isFinal: true },
      { 0: { transcript: "영희" }, isFinal: true },
    ],
  });

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "영희", score: 99 },
  ]);
});

test("a name spoken after game over saves without a fresh speech-start event", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 456;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  finishLatestUtterance(speechSynthesis);
  recognition.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "민지" }, isFinal: true }],
  });

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "민지", score: 456 },
  ]);
  assert.equal(api.state.replayPrompt, true);
});

test("a real name saves after game-over TTS tagged the speech as system", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 654;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  speechSynthesis.speaking = true;
  recognition.onspeechstart();
  finishLatestUtterance(speechSynthesis);
  recognition.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "서준" }, isFinal: true }],
  });

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "서준", score: 654 },
  ]);
  assert.equal(api.state.replayPrompt, true);
});

test("the recognizable game-over TTS hint is not saved as a player name", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 777;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  speechSynthesis.speaking = true;
  recognition.onspeechstart();
  speechSynthesis.speaking = false;
  recognition.onresult({
    resultIndex: 0,
    results: [{
      0: { transcript: "게임 오버 이름을 말하면 점수를 저장할 수 있습니다" },
      isFinal: true,
    }],
  });

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);
});

test("a game-over TTS echo without a fresh speech-start event is not saved as a name", () => {
  const { api, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 782;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  recognition.onresult({
    resultIndex: 0,
    results: [{
      0: { transcript: "게임 오버 이름을 말하면 점수를 저장할 수 있습니다" },
      isFinal: true,
      length: 1,
    }],
  });

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);
});

test("name capture waits until the game-over prompt has finished", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 783;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  const prompt = speechSynthesis.latestUtterance;
  assert.ok(prompt, "expected game-over speech prompt");

  recognition.onresult({
    resultIndex: 0,
    results: [{
      0: { transcript: "점수를 기록" },
      isFinal: true,
      length: 1,
    }],
  });

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);
  speechSynthesis.speaking = false;
  assert.equal(typeof prompt.onend, "function");
  prompt.onend();

  recognition.onresult({
    resultIndex: 1,
    results: [
      { 0: { transcript: "점수를 기록" }, isFinal: true, length: 1 },
      { 0: { transcript: "민수" }, isFinal: true, length: 1 },
    ],
  });

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "민수", score: 783 },
  ]);
  assert.equal(api.state.replayPrompt, true);
});

test("a short system-tagged game-over TTS partial is not saved as a name", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 778;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  speechSynthesis.speaking = true;
  recognition.onspeechstart();
  speechSynthesis.speaking = false;
  recognition.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "게임 오버" }, isFinal: true }],
  });

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);
});

test("a two-character system-tagged TTS fragment is not saved as a name", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 781;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  speechSynthesis.speaking = true;
  recognition.onspeechstart();
  speechSynthesis.speaking = false;
  recognition.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "게임" }, isFinal: true }],
  });

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);
});

test("a delayed natural gameplay phrase is not saved as a player name", () => {
  const { api, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 779;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  api.gameOver();
  recognition.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "오른쪽으로 가" }, isFinal: true }],
  });

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);
});

test("a valid alias-only name saves after game over", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 780;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  finishLatestUtterance(speechSynthesis);
  recognition.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "오우" }, isFinal: true }],
  });

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "오우", score: 780 },
  ]);
  assert.equal(api.state.replayPrompt, true);
});

test("the first pop command in a restarted recognition session fires", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 3;
  api.player.cooldown = 0;
  api.initRecognition();

  api.handleVoiceCommand("뿅", {
    isFinal: false,
    resultIndex: 0,
    speechScene: "playing",
  });
  assert.equal(api.bullets.length, 1);
  assert.equal(api.bullets[0].lane, 3);

  api.player.cooldown = 0;
  api.getRecognition().onstart();
  api.handleVoiceCommand("뿅", {
    isFinal: false,
    resultIndex: 0,
    speechScene: "playing",
  });

  assert.equal(api.bullets.length, 2);
  assert.equal(api.bullets[1].lane, 3);
});

test("a pop command received during cooldown fires once when ready", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 1;
  api.player.cooldown = 0.05;
  api.state.processedPosMap = {};

  api.handleVoiceCommand("뿅", {
    isFinal: false,
    resultIndex: 2,
    speechScene: "playing",
  });
  assert.equal(api.bullets.length, 0);

  api.update(0.1);
  assert.equal(api.bullets.length, 1);
  assert.equal(api.bullets[0].lane, 1);
});

test("an evolving interim transcript does not queue a duplicate shot", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  recognition.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "오른쪽뿅" }, isFinal: false }],
  });

  assert.equal(api.player.lane, 3);
  assert.equal(api.bullets.length, 1);
  assert.equal(api.bullets[0].lane, 3);

  recognition.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "오른쪽으로뿅" }, isFinal: false }],
  });
  api.update(1);

  assert.equal(api.bullets.length, 1);
});

test("a lower speech-recognition alternative matching pop fires once in the current lane", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 4;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  recognition.onresult({
    resultIndex: 0,
    results: [{
      0: { transcript: "병", confidence: 0.72 },
      1: { transcript: "뿅", confidence: 0.28 },
      isFinal: true,
      length: 2,
    }],
  });

  assert.equal(api.bullets.length, 1);
  assert.equal(api.bullets[0].lane, 4);
});

test("an immediate overlap hit still leaves visible shot feedback", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.enemies.push({
    lane: 2,
    x: 0,
    y: api.player.y - 20,
    w: 32,
    h: 32,
    vy: 0,
    hp: 1,
    type: "invader",
    t: 0,
  });
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  recognition.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "뿅" }, isFinal: true, length: 1 }],
  });
  assert.equal(api.bullets.length, 1);

  api.update(1 / 60);

  assert.equal(api.bullets.length, 0);
  assert.equal(api.enemies.length, 0);
  assert.ok(api.player.shotFlash > 0);
});
