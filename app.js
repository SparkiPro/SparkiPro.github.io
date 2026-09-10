"use strict";

/**
 * app.js — «Спарки»
 * ====================
 * Вся логика фронтенда: история диалога (localStorage), отправка сообщений
 * (текст и/или фото) в Pollinations.AI, потоковый вывод ответа, установка
 * как приложение на телефон (PWA).
 *
 * Бэкенд — Pollinations.AI (https://pollinations.ai): открытый бесплатный
 * ИИ-сервис, который не требует НИКАКОЙ регистрации — ни API-ключа, ни
 * почты, ни тем более номера телефона. Раньше здесь был Puter.js, но он
 * при первом обращении просит войти в аккаунт, а верификация по SMS у
 * него не поддерживает российские номера — так что заменили на то, что
 * действительно работает без единого поля регистрации. Подробности и
 * ограничения (анонимный лимит — примерно 1 запрос в 15 секунд) — в README.
 */

// -------------------------------------------------------------------------
// Состояние и константы
// -------------------------------------------------------------------------

const STORAGE_KEY = "sparky.history.v2";
const MODEL_KEY = "sparky.model.v1";
const API_URL = "https://text.pollinations.ai/openai?referrer=sparky-app";

// Сколько последних сообщений храним и отправляем — чтобы не раздувать
// localStorage и запросы бесконечно растущей историей.
const MAX_HISTORY = 40;
// Фото — самая "тяжёлая" часть истории. Полное изображение (base64)
// отправляем модели только для последних N сообщений с фото, у более
// старых оставляем только текст — иначе каждый запрос со временем начнёт
// весить мегабайты и упрётся в лимиты.
const MAX_IMAGES_IN_CONTEXT = 3;
// Перед отправкой/сохранением сжимаем фото до разумного размера.
const IMAGE_MAX_DIMENSION = 1280;
const IMAGE_JPEG_QUALITY = 0.75;

const SYSTEM_PROMPT =
  "Ты — дружелюбный помощник по имени Спарки внутри мобильного приложения. " +
  "Отвечай на русском языке, понятно и по делу. Если прислали фото — сначала " +
  "разберись, что на нём (задача, текст, объект и т.п.), и помоги с тем, о " +
  "чём просит пользователь. Если объясняешь решение — веди по шагам. Ответы " +
  "должны быть в простом тексте: разрешён **жирный текст**, списки через " +
  "дефис или цифры, `код` в обратных кавычках — без таблиц и заголовков " +
  "markdown, они плохо смотрятся в чате на телефоне.";

/** @type {Array<{role: 'user'|'assistant', text: string, imageDataUrl?: string, ts: number}>} */
let history = loadHistory();
let pendingImageDataUrl = null;
let isSending = false;

// -------------------------------------------------------------------------
// DOM
// -------------------------------------------------------------------------

const chatLog = document.getElementById("chatLog");
const emptyState = document.getElementById("emptyState");
const composer = document.getElementById("composer");
const textInput = document.getElementById("textInput");
const sendBtn = document.getElementById("sendBtn");
const attachBtn = document.getElementById("attachBtn");
const photoInput = document.getElementById("photoInput");
const imageStage = document.getElementById("imageStage");
const imageStageImg = document.getElementById("imageStageImg");
const imageStageRemove = document.getElementById("imageStageRemove");
const clearBtn = document.getElementById("clearBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const modelSelect = document.getElementById("modelSelect");
const installTip = document.getElementById("installTip");
const installTipClose = document.getElementById("installTipClose");

// -------------------------------------------------------------------------
// Персистентность
// -------------------------------------------------------------------------

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn("Не удалось прочитать историю:", e);
    return [];
  }
}

function saveHistory() {
  try {
    if (history.length > MAX_HISTORY) {
      history = history.slice(history.length - MAX_HISTORY);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch (e) {
    // Скорее всего переполнено хранилище (много крупных фото в истории) —
    // подчищаем самые старые сообщения с картинками и пробуем ещё раз.
    console.warn("Не удалось сохранить историю, пробую освободить место:", e);
    const idx = history.findIndex((m) => m.imageDataUrl);
    if (idx !== -1) {
      history[idx] = { ...history[idx], imageDataUrl: undefined };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch (e2) { /* сдаёмся молча */ }
    }
  }
}

function loadModel() {
  return localStorage.getItem(MODEL_KEY) || "openai";
}

function saveModel(model) {
  localStorage.setItem(MODEL_KEY, model);
}

// -------------------------------------------------------------------------
// Рендер
// -------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/** Очень лёгкий markdown -> HTML: жирный, курсив, код, списки, абзацы.
 * Текст ВСЕГДА сначала экранируется, форматирование применяется поверх
 * уже безопасного HTML — так ответ модели не может вставить произвольную
 * разметку. */
function renderMarkdownLite(raw) {
  const escaped = escapeHtml(raw);
  const lines = escaped.split("\n");
  let html = "";
  let listType = null; // 'ul' | 'ol' | null

  function closeList() {
    if (listType) {
      html += listType === "ul" ? "</ul>" : "</ol>";
      listType = null;
    }
  }

  function inline(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const bullet = line.match(/^[-*•]\s+(.*)/);
    const numbered = line.match(/^\d+[.)]\s+(.*)/);

    if (bullet) {
      if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
      html += `<li>${inline(bullet[1])}</li>`;
    } else if (numbered) {
      if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
      html += `<li>${inline(numbered[1])}</li>`;
    } else if (line === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html || "<p></p>";
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function scrollToBottom() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function updateEmptyState() {
  emptyState.hidden = history.length > 0;
}

function renderMessage(msg) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${msg.role}`;

  if (msg.imageDataUrl) {
    const img = document.createElement("img");
    img.className = "msg-image";
    img.src = msg.imageDataUrl;
    img.alt = "Прикреплённое фото";
    wrap.appendChild(img);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = renderMarkdownLite(msg.text || "");
  wrap.appendChild(bubble);

  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = formatTime(msg.ts || Date.now());
  wrap.appendChild(time);

  chatLog.appendChild(wrap);
  return bubble;
}

function renderAll() {
  chatLog.querySelectorAll(".msg").forEach((el) => el.remove());
  history.forEach(renderMessage);
  updateEmptyState();
  scrollToBottom();
}

// -------------------------------------------------------------------------
// Фото: сжатие в браузере (canvas) перед отправкой/сохранением
// -------------------------------------------------------------------------

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Не удалось прочитать изображение."));
    img.src = src;
  });
}

/** Уменьшает фото до IMAGE_MAX_DIMENSION по большей стороне и сжимает в
 * JPEG — так и запрос к ИИ, и localStorage не раздуваются от фото 12 МП
 * прямо с камеры телефона. */
async function resizeImageFile(file) {
  const rawDataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(rawDataUrl);

  let { width, height } = img;
  if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) {
    const scale = IMAGE_MAX_DIMENSION / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
}

// -------------------------------------------------------------------------
// Сборка сообщений для Pollinations (формат, совместимый с OpenAI)
// -------------------------------------------------------------------------

function historyToApiMessages() {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  const imageIndexes = [];
  history.forEach((m, i) => { if (m.imageDataUrl) imageIndexes.push(i); });
  const keepImagesFrom = new Set(imageIndexes.slice(-MAX_IMAGES_IN_CONTEXT));

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.imageDataUrl && keepImagesFrom.has(i)) {
      messages.push({
        role: msg.role,
        content: [
          { type: "text", text: msg.text || "Что на фото?" },
          { type: "image_url", image_url: { url: msg.imageDataUrl } },
        ],
      });
    } else if (msg.imageDataUrl) {
      // Старое фото вне окна контекста — оставляем только текст, чтобы не
      // раздувать запрос, но не терять саму реплику из разговора.
      messages.push({ role: msg.role, content: `[фото] ${msg.text || ""}`.trim() });
    } else {
      messages.push({ role: msg.role, content: msg.text });
    }
  }
  return messages;
}

// -------------------------------------------------------------------------
// Запрос к Pollinations.AI: стриминг (SSE) с запасным вариантом без него
// -------------------------------------------------------------------------

async function streamChat(apiMessages, model, onChunk) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: apiMessages, stream: true }),
  });

  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`Сервер ответил с ошибкой (${response.status}).`), {
      status: response.status,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // последняя строка может быть неполной

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;
      try {
        const json = JSON.parse(dataStr);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onChunk(full);
        }
      } catch (e) {
        // Неполный/невалидный чанк — просто пропускаем, следующий кусок
        // обычно "дочинивает" JSON.
      }
    }
  }
  return full;
}

async function chatOnce(apiMessages, model) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: apiMessages, stream: false }),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Сервер ответил с ошибкой (${response.status}).`), {
      status: response.status,
    });
  }
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}

// -------------------------------------------------------------------------
// Отправка сообщения
// -------------------------------------------------------------------------

async function handleSend(event) {
  event.preventDefault();
  if (isSending) return;

  const text = textInput.value.trim();
  const imageDataUrl = pendingImageDataUrl;
  if (!text && !imageDataUrl) return;

  setSending(true);

  const userMsg = {
    role: "user",
    text: text || (imageDataUrl ? "Что на этом фото?" : ""),
    ts: Date.now(),
  };
  if (imageDataUrl) userMsg.imageDataUrl = imageDataUrl;

  textInput.value = "";
  autoGrowTextarea();
  clearStagedImage();

  history.push(userMsg);
  renderMessage(userMsg);
  updateEmptyState();
  scrollToBottom();
  saveHistory();

  // Ответ ассистента печатается в тот же пузырь по мере поступления кусков.
  const assistantMsg = { role: "assistant", text: "", ts: Date.now() };
  const bubble = renderMessage(assistantMsg);
  bubble.classList.add("thinking");
  bubble.textContent = "Думаю…";
  scrollToBottom();

  try {
    const apiMessages = historyToApiMessages();
    const model = loadModel();

    let full = "";
    try {
      full = await streamChat(apiMessages, model, (partial) => {
        if (bubble.classList.contains("thinking")) bubble.classList.remove("thinking");
        bubble.innerHTML = renderMarkdownLite(partial);
        scrollToBottom();
      });
    } catch (streamErr) {
      console.warn("Стриминг не удался, пробую без него:", streamErr);
      full = await chatOnce(apiMessages, model);
      bubble.classList.remove("thinking");
      bubble.innerHTML = renderMarkdownLite(full);
    }

    if (!full.trim()) {
      full = "Не получилось сформировать ответ. Попробуйте переформулировать вопрос.";
      bubble.innerHTML = renderMarkdownLite(full);
    }

    assistantMsg.text = full;
    history.push(assistantMsg);
    saveHistory();
  } catch (err) {
    console.error(err);
    bubble.classList.remove("thinking");
    bubble.classList.add("error-bubble");
    let message = "Не получилось получить ответ. Проверьте интернет-соединение и попробуйте ещё раз.";
    if (err && err.status === 429) {
      message = "Слишком много запросов подряд — подождите секунд 15 и повторите (это бесплатный сервис без регистрации, у него есть лимит скорости).";
    } else if (err && err.message) {
      message += `\n\n(${err.message})`;
    }
    bubble.textContent = message;
    // Ошибочный ответ не сохраняем в историю — при повторной попытке не
    // будет "мусорных" ответов в контексте.
  } finally {
    setSending(false);
    scrollToBottom();
  }
}

function setSending(value) {
  isSending = value;
  sendBtn.disabled = value;
  sendBtn.classList.toggle("sending", value);
  textInput.disabled = value;
  attachBtn.disabled = value;
}

// -------------------------------------------------------------------------
// Фото: выбор, превью, удаление
// -------------------------------------------------------------------------

attachBtn.addEventListener("click", () => photoInput.click());

photoInput.addEventListener("change", async () => {
  const file = photoInput.files && photoInput.files[0];
  if (!file) return;
  attachBtn.disabled = true;
  try {
    pendingImageDataUrl = await resizeImageFile(file);
    imageStageImg.src = pendingImageDataUrl;
    imageStage.hidden = false;
    textInput.focus();
  } catch (e) {
    console.error(e);
    alert("Не удалось обработать фото. Попробуйте другое изображение.");
  } finally {
    attachBtn.disabled = false;
  }
});

imageStageRemove.addEventListener("click", clearStagedImage);

function clearStagedImage() {
  pendingImageDataUrl = null;
  imageStage.hidden = true;
  imageStageImg.src = "";
  photoInput.value = "";
}

// -------------------------------------------------------------------------
// Ввод текста
// -------------------------------------------------------------------------

function autoGrowTextarea() {
  textInput.style.height = "auto";
  textInput.style.height = Math.min(textInput.scrollHeight, 120) + "px";
}

textInput.addEventListener("input", autoGrowTextarea);

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener("submit", handleSend);

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    textInput.value = chip.dataset.prompt || "";
    autoGrowTextarea();
    textInput.focus();
  });
});

// -------------------------------------------------------------------------
// Новый разговор
// -------------------------------------------------------------------------

clearBtn.addEventListener("click", () => {
  if (history.length === 0) return;
  const ok = confirm("Начать новый разговор? Текущая история будет удалена.");
  if (!ok) return;

  history = [];
  saveHistory();
  renderAll();
});

// -------------------------------------------------------------------------
// Настройки (выбор модели)
// -------------------------------------------------------------------------

modelSelect.value = loadModel();
modelSelect.addEventListener("change", () => saveModel(modelSelect.value));

settingsBtn.addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

// -------------------------------------------------------------------------
// PWA: сервис-воркер + подсказка про установку на iOS
// -------------------------------------------------------------------------

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((e) => {
      console.warn("Service worker не зарегистрирован:", e);
    });
  });
}

const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

if (isIOS && !isStandalone && !localStorage.getItem("sparky.installTipDismissed")) {
  installTip.hidden = false;
}

installTipClose.addEventListener("click", () => {
  installTip.hidden = true;
  localStorage.setItem("sparky.installTipDismissed", "1");
});

// -------------------------------------------------------------------------
// Инициализация
// -------------------------------------------------------------------------

renderAll();
autoGrowTextarea();
