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
    click() {
      const handler = listeners.get("click");
      if (handler) handler({ preventDefault() {} });
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
      enemyHitPoints: typeof enemyHitPoints === "function" ? enemyHitPoints : null,
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
  let nowMs = 10_000;
  const clock = {
    now: () => nowMs,
    set(value) { nowMs = Number(value); },
  };

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
    performance: clock,
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

  return { api: context.__testApi, clock, getElement, speechSynthesis, storage };
}

function finishLatestUtterance(speechSynthesis) {
  const utterance = speechSynthesis.latestUtterance;
  speechSynthesis.speaking = false;
  if (utterance && typeof utterance.onend === "function") utterance.onend();
}

function emitRecognitionResult(recognition, transcripts, resultIndex = 0, isFinal = true) {
  const alternatives = Array.isArray(transcripts) ? transcripts : [transcripts];
  const result = { isFinal, length: alternatives.length };
  alternatives.forEach((transcript, index) => {
    result[index] = { transcript };
  });
  const results = Array.from({ length: resultIndex }, () => null);
  results.push(result);
  recognition.onresult({ resultIndex, results });
}

function requestNameCapture(api, speechSynthesis, recognition, resultIndex = 0, tagAsSystem = false) {
  api.gameOver();
  assert.match(speechSynthesis.latestUtterance.text, /점수.*저장.*까요/);
  finishLatestUtterance(speechSynthesis);
  emitRecognitionResult(recognition, "예", resultIndex);

  const namePrompt = speechSynthesis.latestUtterance;
  assert.ok(namePrompt, "expected name prompt after accepting score save");
  assert.match(namePrompt.text, /이름.*말/);
  if (tagAsSystem) recognition.onspeechstart();
  finishLatestUtterance(speechSynthesis);
  return resultIndex + 1;
}

test("accepting score save stores the final player name immediately exactly once", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 321;
  api.initRecognition();

  const recognition = api.getRecognition();
  const nameResultIndex = requestNameCapture(api, speechSynthesis, recognition);
  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  emitRecognitionResult(recognition, "민수", nameResultIndex);

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "민수", score: 321 },
  ]);
  assert.equal(api.state.replayPrompt, true);
});

test("stale gameplay speech never saves before yes and the final name saves once", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 99;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  api.gameOver();
  assert.match(speechSynthesis.latestUtterance.text, /점수.*저장.*까요/);
  emitRecognitionResult(recognition, "뿅뿅뿅", 0);
  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);

  finishLatestUtterance(speechSynthesis);
  emitRecognitionResult(recognition, "예", 1);
  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);

  const namePrompt = speechSynthesis.latestUtterance;
  assert.match(namePrompt.text, /이름.*말/);
  finishLatestUtterance(speechSynthesis);
  emitRecognitionResult(recognition, "민수", 2);

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "민수", score: 99 },
  ]);
  assert.equal(api.state.replayPrompt, true);
});

test("a name spoken after the name prompt saves without a fresh speech-start event", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 456;
  api.initRecognition();

  const recognition = api.getRecognition();
  const nameResultIndex = requestNameCapture(api, speechSynthesis, recognition);
  emitRecognitionResult(recognition, "민지", nameResultIndex);

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "민지", score: 456 },
  ]);
  assert.equal(api.state.replayPrompt, true);
});

test("a real name saves after name-prompt TTS tagged the speech as system", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 654;
  api.initRecognition();

  const recognition = api.getRecognition();
  const nameResultIndex = requestNameCapture(api, speechSynthesis, recognition, 0, true);
  emitRecognitionResult(recognition, "서준", nameResultIndex);

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "서준", score: 654 },
  ]);
  assert.equal(api.state.replayPrompt, true);
});

test("the recognizable score-save TTS hint is not treated as a decision or name", () => {
  const { api, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 777;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  emitRecognitionResult(recognition, "게임 오버 점수를 저장할까요", 0);

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);
});

test("a score-save TTS echo without a fresh speech-start event is ignored", () => {
  const { api, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 782;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  emitRecognitionResult(recognition, "점수를 저장할까요", 0);

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);
});

test("score decision and name capture both wait until their prompts finish", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 783;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  const savePrompt = speechSynthesis.latestUtterance;
  assert.ok(savePrompt, "expected score-save prompt");
  assert.match(savePrompt.text, /점수.*저장.*까요/);
  emitRecognitionResult(recognition, "점수를 기록", 0);
  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);

  finishLatestUtterance(speechSynthesis);
  emitRecognitionResult(recognition, "예", 1);
  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  const namePrompt = speechSynthesis.latestUtterance;
  assert.ok(namePrompt, "expected player-name prompt");
  assert.match(namePrompt.text, /이름.*말/);

  emitRecognitionResult(recognition, "이름을 기록", 2);
  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);

  finishLatestUtterance(speechSynthesis);
  emitRecognitionResult(recognition, "민수", 3);
  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "민수", score: 783 },
  ]);
  assert.equal(api.state.replayPrompt, true);
});

test("a short system-tagged score-save prompt partial is ignored", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 778;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  recognition.onspeechstart();
  speechSynthesis.speaking = false;
  emitRecognitionResult(recognition, "점수를", 0);

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);
});

test("a two-character system-tagged score prompt fragment is ignored", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 781;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  recognition.onspeechstart();
  speechSynthesis.speaking = false;
  emitRecognitionResult(recognition, "점수", 0);

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);
});

test("a delayed natural gameplay phrase is not treated as a save decision", () => {
  const { api, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 779;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  api.gameOver();
  emitRecognitionResult(recognition, "오른쪽으로 가", 0);

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, false);
});

test("a valid alias-only name saves after score saving was accepted", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 780;
  api.initRecognition();

  const recognition = api.getRecognition();
  const nameResultIndex = requestNameCapture(api, speechSynthesis, recognition);
  emitRecognitionResult(recognition, "오우", nameResultIndex);

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "오우", score: 780 },
  ]);
  assert.equal(api.state.replayPrompt, true);
});

test("declining score save skips the name and asks whether to replay", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 784;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  assert.match(speechSynthesis.latestUtterance.text, /점수.*저장.*까요/);
  finishLatestUtterance(speechSynthesis);
  emitRecognitionResult(recognition, "아니오", 0);

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.replayPrompt, true);
  assert.match(speechSynthesis.latestUtterance.text, /다시.*플레이/);
});

test("save confirmation accepts an exact lower yes alternative", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 785;
  api.initRecognition();

  const recognition = api.getRecognition();
  api.gameOver();
  finishLatestUtterance(speechSynthesis);
  emitRecognitionResult(recognition, ["내", "네"], 0);

  assert.equal(storage.get("voiceShooter.scores.v1"), undefined);
  assert.equal(api.state.nameEntry.phase, "nameEntry");
  assert.match(speechSynthesis.latestUtterance.text, /이름.*말/);
});

test("replay confirmation accepts an exact lower yes alternative", () => {
  const { api } = loadGame();
  api.state.scene = "gameover";
  api.state.nameEntry.phase = "replayConfirm";
  api.state.nameCaptureReady = true;
  api.state.replayPrompt = true;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  emitRecognitionResult(recognition, ["내", "네"], 0);

  assert.equal(api.state.nameCaptureReady, false);
  assert.match(api.state.message, /다시 시작/);
});

for (const spokenNo of ["아니오", "아니요"]) {
  test(`replay confirmation exits to boot for ${spokenNo}`, () => {
    const { api } = loadGame();
    api.state.scene = "gameover";
    api.state.nameEntry.phase = "replayConfirm";
    api.state.nameCaptureReady = true;
    api.state.replayPrompt = true;
    api.initRecognition();

    const recognition = api.getRecognition();
    recognition.onspeechstart();
    emitRecognitionResult(recognition, spokenNo, 0);

    assert.equal(api.state.scene, "boot");
    assert.equal(api.state.nameCaptureReady, false);
  });
}
for (const spokenNo of ["아니오", "아니요"]) {
  test(`replay confirmation exits immediately for interim exact ${spokenNo}`, () => {
    const { api } = loadGame();
    api.state.scene = "gameover";
    api.state.nameEntry.phase = "replayConfirm";
    api.state.nameCaptureReady = true;
    api.state.replayPrompt = true;
    api.initRecognition();

    const recognition = api.getRecognition();
    recognition.onspeechstart();
    emitRecognitionResult(recognition, spokenNo, 0, false);

    assert.equal(api.state.scene, "boot");
    assert.equal(api.state.nameCaptureReady, false);
  });
}

test("replay confirmation does not exit for a longer interim no-like phrase", () => {
  const { api } = loadGame();
  api.state.scene = "gameover";
  api.state.nameEntry.phase = "replayConfirm";
  api.state.nameCaptureReady = true;
  api.state.replayPrompt = true;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "아니오세요", 0, false);

  assert.equal(api.state.scene, "gameover");
  assert.equal(api.state.nameCaptureReady, true);
});
test("a fresh fire-sounding name is saved after the player explicitly chose save", () => {
  const { api, speechSynthesis, storage } = loadGame();
  api.state.scene = "playing";
  api.state.score = 786;
  api.initRecognition();

  const recognition = api.getRecognition();
  const nameResultIndex = requestNameCapture(api, speechSynthesis, recognition);
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "탕", nameResultIndex);

  const scores = JSON.parse(storage.get("voiceShooter.scores.v1") || "[]");
  assert.deepEqual(scores.map(({ name, score }) => ({ name, score })), [
    { name: "탕", score: 786 },
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

test("a repeated right prefix moves once and the following pop fires once", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "오른쪽", 0);
  assert.equal(api.player.lane, 3);
  assert.equal(api.bullets.length, 0);

  emitRecognitionResult(recognition, "오른쪽 뿅", 1);

  assert.equal(api.player.lane, 3);
  assert.equal(api.bullets.length, 1);
  assert.equal(api.bullets[0].lane, 3);
});
test("separate final pop results in one speech segment each fire", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();

  emitRecognitionResult(recognition, "뿅", 0);
  assert.equal(api.bullets.length, 1);
  api.update(1);

  emitRecognitionResult(recognition, "뿅", 1);
  assert.equal(api.bullets.length, 2);
  api.update(1);

  emitRecognitionResult(recognition, "뿅", 2);
  assert.equal(api.bullets.length, 3);
  assert.deepEqual(Array.from(api.bullets, (bullet) => bullet.lane), [2, 2, 2]);
});

test("separate final right results in one speech segment each move once", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 1;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "오른쪽", 0);
  assert.equal(api.player.lane, 2);

  emitRecognitionResult(recognition, "오른쪽", 1);
  assert.equal(api.player.lane, 3);
});
test("a later compound command containing pop still fires as a new final result", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "뿅", 0);
  assert.equal(api.player.lane, 2);
  assert.equal(api.bullets.length, 1);
  api.update(1);

  emitRecognitionResult(recognition, "오른쪽 뿅", 1);

  assert.equal(api.player.lane, 3);
  assert.equal(api.bullets.length, 2);
  assert.deepEqual(Array.from(api.bullets, (bullet) => bullet.lane), [2, 3]);
});
test("a prefix compound final treats pop as a new fire command", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "뿅", 0);
  assert.equal(api.player.lane, 2);
  assert.equal(api.bullets.length, 1);
  api.update(1);

  emitRecognitionResult(recognition, "뿅 오른쪽", 1);

  assert.equal(api.player.lane, 3);
  assert.equal(api.bullets.length, 2);
  assert.deepEqual(Array.from(api.bullets, (bullet) => bullet.lane), [2, 3]);
});
test("a new speech-start extension adds fire without repeating its right move", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "오른쪽", 0);
  assert.equal(api.player.lane, 3);

  recognition.onspeechstart();
  emitRecognitionResult(recognition, "오른쪽 뿅", 1);

  assert.equal(api.player.lane, 3);
  assert.equal(api.bullets.length, 1);
  assert.equal(api.bullets[0].lane, 3);
});
test("a delayed expansion in the same speech segment does not repeat its right move", () => {
  const { api, clock } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  clock.set(10_000);
  emitRecognitionResult(recognition, "오른쪽", 0);
  assert.equal(api.player.lane, 3);

  clock.set(10_350);
  emitRecognitionResult(recognition, "오른쪽 뿅", 1);

  assert.equal(api.player.lane, 3);
  assert.equal(api.bullets.length, 1);
  assert.equal(api.bullets[0].lane, 3);
});

test("a new speech segment can repeat the same right command within the time window", () => {
  const { api, clock } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.initRecognition();

  const recognition = api.getRecognition();
  clock.set(10_000);
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "오른쪽", 0);
  assert.equal(api.player.lane, 3);

  clock.set(10_100);
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "오른쪽", 1);

  assert.equal(api.player.lane, 4);
});

test("two explicit right commands in one result move two lanes", () => {
  const { api, clock } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 1;
  api.initRecognition();

  const recognition = api.getRecognition();
  clock.set(10_000);
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "오른쪽 오른쪽", 0);

  assert.equal(api.player.lane, 3);
});
test("a repeated top right alternative yields to an exact lower pop command", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "오른쪽", 0);
  assert.equal(api.player.lane, 3);

  recognition.onspeechstart();
  emitRecognitionResult(recognition, ["오른쪽", "뿅"], 1);

  assert.equal(api.player.lane, 3);
  assert.equal(api.bullets.length, 1);
  assert.equal(api.bullets[0].lane, 3);
});

test("a fresh alternative set keeps its strong top right command", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  emitRecognitionResult(recognition, ["오른쪽", "뿅"], 0);

  assert.equal(api.player.lane, 3);
  assert.equal(api.bullets.length, 0);
});
test("an immediate top-only repeated right result falls back to firing", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  emitRecognitionResult(recognition, "오른쪽", 0);
  assert.equal(api.player.lane, 3);

  recognition.onspeechstart();
  emitRecognitionResult(recognition, "오른쪽", 1);

  assert.equal(api.player.lane, 3);
  assert.equal(api.bullets.length, 1);
  assert.equal(api.bullets[0].lane, 3);
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

test("a non-command primary alternative does not let a fuzzy lower alternative move right", () => {
  const { api } = loadGame();
  api.state.scene = "playing";
  api.player.lane = 2;
  api.player.cooldown = 0;
  api.initRecognition();

  const recognition = api.getRecognition();
  recognition.onspeechstart();
  emitRecognitionResult(recognition, ["민수", "오늘"], 0);

  assert.equal(api.player.lane, 2);
  assert.equal(api.bullets.length, 0);
});

test("easy UFOs take one shot while a normal stage-four UFO takes more", () => {
  const { api } = loadGame();
  assert.equal(typeof api.enemyHitPoints, "function");

  api.state.difficulty = "easy";
  api.state.stage = 4;
  assert.equal(api.enemyHitPoints(true), 1);

  api.state.difficulty = "normal";
  api.state.stage = 4;
  assert.ok(api.enemyHitPoints(true) > 1);
});

test("the settings button is ignored while a game-over prompt owns the microphone", () => {
  const { api, getElement, speechSynthesis } = loadGame();
  api.state.scene = "playing";
  api.initRecognition();

  api.gameOver();
  assert.equal(api.state.nameCaptureReady, false);
  getElement("touchSettings").click();

  assert.equal(api.state.scene, "gameover");
  assert.equal(api.state.nameCaptureReady, false);
  finishLatestUtterance(speechSynthesis);
  assert.equal(api.state.recognitionActive, true);
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
