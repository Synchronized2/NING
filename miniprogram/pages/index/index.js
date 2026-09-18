const {
  createChatCompletion,
  createImage,
  materializeImage,
  parseImageToolCall,
  prepareImageAttachment,
  synthesizeSpeech,
} = require("../../utils/openai");
const {
  createConversation,
  getActiveConversationId,
  getConversation,
  getSettings,
  isChatConfigured,
  isImageConfigured,
  recordUsage,
  saveConversation,
  saveSettings,
} = require("../../utils/storage");

const IMAGE_TOOL = {
  type: "function",
  function: {
    name: "generate_image",
    description: "Generate an image only when the user explicitly asks to create, draw, or generate one.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string", description: "A complete standalone prompt for the image generation model." } },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
};

const TOOL_GUIDANCE = "当用户明确要求生成、绘制或创作图片时，必须调用 generate_image，并把完整、可直接生图的描述放进 prompt。普通图片分析、询问生图方法或非图片内容创作不要调用该工具。";
const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"];
const IMAGE_QUALITIES = ["standard", "hd"];
const IMAGE_STYLES = ["vivid", "natural"];
const IMAGE_TEMPLATES = [
  { name: "摄影", prompt: "专业摄影作品，自然光线，真实材质，构图清晰：" },
  { name: "插画", prompt: "精致数字插画，色彩协调，细节丰富：" },
  { name: "海报", prompt: "现代商业海报，主体突出，留白合理，无乱码文字：" },
  { name: "头像", prompt: "适合作为头像的方形构图，主体居中，背景简洁：" },
];

function newMessageId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function elapsedText(startedAt) {
  const seconds = (Date.now() - startedAt) / 1000;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
}

function cleanSpeechText(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " 代码片段 ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[>*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}

function normalizedUsage(value) {
  const usage = value || {};
  const promptTokens = Number(usage.prompt_tokens || usage.input_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens || usage.output_tokens) || 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(usage.total_tokens) || promptTokens + completionTokens,
  };
}

function usageMeta(settings, usage) {
  const tokens = normalizedUsage(usage);
  const estimatedCost = (tokens.promptTokens / 1000000 * settings.inputPrice) +
    (tokens.completionTokens / 1000000 * settings.outputPrice);
  recordUsage({ ...tokens, estimatedCost });
  if (!tokens.totalTokens) return { text: "", cost: estimatedCost };
  return {
    text: `${tokens.totalTokens} tokens${estimatedCost ? ` · $${estimatedCost.toFixed(4)}` : ""}`,
    cost: estimatedCost,
  };
}

function currentWindowHeight() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const height = Number(info && info.windowHeight);
    return Number.isFinite(height) && height > 0 ? height : 0;
  } catch (_) {
    return 0;
  }
}

Page({
  data: {
    configured: false,
    imageConfigured: false,
    chatModel: "未配置模型",
    imageModel: "未配置生图模型",
    profileName: "默认服务",
    mode: "chat",
    inputValue: "",
    messages: [],
    busy: false,
    pageHeight: 0,
    pageHeightStyle: "",
    scrollTarget: "page-bottom",
    placeholder: "输入消息",
    attachment: null,
    preparingAttachment: false,
    autoSpeak: false,
    speaking: false,
    imageSizes: IMAGE_SIZES,
    imageQualities: IMAGE_QUALITIES,
    imageStyles: IMAGE_STYLES,
    imageSizeIndex: 0,
    imageQualityIndex: 0,
    imageStyleIndex: 0,
    imageTemplates: IMAGE_TEMPLATES,
  },

  onLoad() {
    this._keyboardHeight = 0;
    this._windowHeight = currentWindowHeight();
    this._activeConversationId = getActiveConversationId();
    this.setData({ messages: getConversation() });
    this.refreshPageHeight();
  },

  onReady() {
    this.refreshPageHeight();
    this.scheduleLayoutRefresh();
  },

  onShow() {
    this._keyboardHeight = 0;
    this.refreshPageHeight();
    this.scheduleLayoutRefresh();
    const settings = getSettings();
    const activeId = getActiveConversationId();
    const updates = {
      configured: isChatConfigured(settings),
      imageConfigured: isImageConfigured(settings),
      chatModel: settings.chatModel || "未配置模型",
      imageModel: settings.imageModel || "未配置生图模型",
      profileName: settings.profileName || "模型服务",
      autoSpeak: settings.autoSpeak,
      imageSizeIndex: Math.max(0, IMAGE_SIZES.indexOf(settings.imageSize)),
      imageQualityIndex: Math.max(0, IMAGE_QUALITIES.indexOf(settings.imageQuality)),
      imageStyleIndex: Math.max(0, IMAGE_STYLES.indexOf(settings.imageStyle)),
    };
    if (!this.data.busy && activeId !== this._activeConversationId) {
      this._activeConversationId = activeId;
      updates.messages = getConversation();
    }
    this.setData(updates);
  },

  onHide() {
    this._keyboardHeight = 0;
  },

  onResize(event) {
    const height = Number(event && event.size && event.size.windowHeight) || currentWindowHeight();
    if (!height) return;
    if (!this._keyboardHeight) this._windowHeight = height;
    this.applyPageHeight(height);
  },

  onUnload() {
    this._unloaded = true;
    this.abortActiveRequest();
    this.stopSpeech();
    if (this._updateTimer) clearTimeout(this._updateTimer);
    if (this._layoutTimer) clearTimeout(this._layoutTimer);
  },

  applyPageHeight(height) {
    const value = Math.max(320, Math.round(Number(height) || 0));
    if (!value || value === this.data.pageHeight) return;
    this.setData({ pageHeight: value, pageHeightStyle: `height: ${value}px;` });
  },

  refreshPageHeight() {
    const measured = currentWindowHeight();
    if (!measured) return;
    if (!this._keyboardHeight) this._windowHeight = measured;
    const baseline = this._windowHeight || measured;
    const expected = Math.max(320, baseline - this._keyboardHeight);
    const alreadyResized = this._keyboardHeight && measured < baseline - 40;
    this.applyPageHeight(alreadyResized ? measured : expected);
  },

  scheduleLayoutRefresh() {
    if (this._layoutTimer) clearTimeout(this._layoutTimer);
    this._layoutTimer = setTimeout(() => {
      this._layoutTimer = null;
      if (!this._unloaded) this.refreshPageHeight();
    }, 200);
  },

  openSettings() {
    wx.navigateTo({ url: "/pages/settings/settings" });
  },

  openHistory() {
    if (this.data.busy) return;
    wx.navigateTo({ url: "/pages/history/history" });
  },

  changeMode(event) {
    if (this.data.busy) return;
    const mode = event.currentTarget.dataset.mode;
    this.setData({
      mode,
      attachment: mode === "image" ? null : this.data.attachment,
      placeholder: mode === "image" ? "描述你想生成的图片" : "输入消息",
    });
  },

  onInput(event) {
    this.setData({ inputValue: event.detail.value });
  },

  onKeyboardHeightChange(event) {
    const keyboardHeight = Math.max(0, Number(event.detail.height) || 0);
    this._keyboardHeight = keyboardHeight;
    this.refreshPageHeight();
    if (keyboardHeight && this.data.messages.length) this.scrollToBottom(this.data.messages[this.data.messages.length - 1].id);
  },

  async chooseImage() {
    if (this.data.busy || this.data.mode !== "chat") return;
    try {
      const result = await new Promise((resolve, reject) => wx.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["compressed"],
        success: resolve,
        fail: reject,
      }));
      const file = result.tempFiles && result.tempFiles[0];
      if (!file || !file.tempFilePath) return;
      let path = file.tempFilePath;
      if (wx.compressImage) {
        try {
          const compressed = await new Promise((resolve, reject) => wx.compressImage({ src: path, quality: 70, success: resolve, fail: reject }));
          path = compressed.tempFilePath;
        } catch (_) {}
      }
      this.setData({ attachment: { localPath: path, previewUrl: path } });
    } catch (error) {
      if (!String(error.errMsg || "").includes("cancel")) wx.showToast({ title: "选择图片失败", icon: "none" });
    }
  },

  removeAttachment() {
    if (!this.data.busy) this.setData({ attachment: null });
  },

  async prepareAttachment(settings) {
    if (!this.data.attachment || this.data.attachment.fileId || this.data.attachment.dataUrl) return this.data.attachment;
    this.setData({ preparingAttachment: true });
    const operation = prepareImageAttachment(this.data.attachment.localPath, settings.useCloudProxy);
    this._activeRequest = operation;
    try {
      const result = await operation.promise;
      return { ...this.data.attachment, ...result, previewUrl: result.fileId || this.data.attachment.localPath };
    } finally {
      this._activeRequest = null;
      this.setData({ preparingAttachment: false });
    }
  },

  async send() {
    if (this.data.busy) return;
    const prompt = this.data.inputValue.trim();
    if (!prompt && !(this.data.mode === "chat" && this.data.attachment)) return;
    const settings = getSettings();
    if (this.data.mode === "chat" && !isChatConfigured(settings)) return this.openSettings();
    if (this.data.mode === "image" && !isImageConfigured(settings)) {
      wx.showToast({ title: "请先配置生图模型", icon: "none" });
      return this.openSettings();
    }

    this.setData({ busy: true });
    let attachment = null;
    try {
      if (this.data.mode === "chat" && this.data.attachment) attachment = await this.prepareAttachment(settings);
    } catch (error) {
      this.setData({ busy: false });
      if (!error.aborted) wx.showToast({ title: error.message || "图片处理失败", icon: "none" });
      return;
    }
    const content = prompt || "请描述这张图片。";
    const userMessage = { id: newMessageId(), role: "user", type: "text", sourceMode: this.data.mode, content, attachment };
    const assistantMessage = {
      id: newMessageId(), role: "assistant", type: this.data.mode === "image" ? "image" : "text",
      sourceMode: this.data.mode, content: "", prompt: content, pending: true, error: false, meta: "",
    };
    this.appendMessages([userMessage, assistantMessage]);
    this.setData({ inputValue: "", attachment: null });
    if (this.data.mode === "image") await this.runImage(settings, content, assistantMessage.id);
    else await this.runChat(settings, assistantMessage.id);
  },

  appendMessages(items) {
    const messages = this.data.messages.concat(items);
    this.setData({ messages }, () => this.scrollToBottom(items[items.length - 1].id));
    saveConversation(messages);
    this._activeConversationId = getActiveConversationId();
  },

  updateMessage(id, patch, callback, persist = true) {
    const index = this.data.messages.findIndex((item) => item.id === id);
    if (index < 0) return;
    const updates = {};
    Object.keys(patch).forEach((key) => { updates[`messages[${index}].${key}`] = patch[key]; });
    this.setData(updates, () => {
      if (persist) saveConversation(this.data.messages);
      this.scrollToBottom(id);
      if (callback) callback();
    });
  },

  scrollToBottom(id) {
    this.setData({ scrollTarget: `message-${id}` });
  },

  apiMessages() {
    const selected = this.data.messages
      .filter((item) => !item.pending && !item.error && item.sourceMode !== "image" &&
        (item.role === "user" || item.role === "assistant") &&
        (item.content || item.attachment || (item.role === "assistant" && item.type === "image" && item.prompt)))
      .slice(-30);
    const includedAttachments = new Set(selected
      .filter((item) => item.role === "user" && item.attachment)
      .slice(-4)
      .map((item) => item.id));
    return selected.map((item) => {
        if (item.role === "user" && item.attachment) {
          const url = item.attachment.fileId || item.attachment.dataUrl;
          if (url && includedAttachments.has(item.id)) return {
            role: "user",
            content: [
              { type: "text", text: item.content || "请描述这张图片。" },
              { type: "image_url", image_url: { url } },
            ],
          };
        }
        return { role: item.role, content: item.content || `已按要求生成图片：${item.prompt}` };
      });
  },

  async runChat(settings, assistantId) {
    const startedAt = Date.now();
    let streamedText = "";
    const messages = [];
    if (settings.systemPrompt) messages.push({ role: "system", content: settings.systemPrompt });
    if (isImageConfigured(settings)) messages.push({ role: "system", content: TOOL_GUIDANCE });
    messages.push(...this.apiMessages());
    const onDelta = (delta) => {
      streamedText += delta;
      this.scheduleStreamUpdate(assistantId, streamedText);
    };
    let speechText = "";
    try {
      let result;
      try {
        result = await this.performChatRequest(settings, messages, onDelta, true);
      } catch (error) {
        if (error.statusCode !== 400 || settings.useCloudProxy || !isImageConfigured(settings) || error.aborted) throw error;
        streamedText = "";
        this.flushStreamUpdate(assistantId, "");
        result = await this.performChatRequest(settings, messages, onDelta, false);
      }
      const imageCall = result.toolCalls.map(parseImageToolCall).find(Boolean);
      if (imageCall) {
        this.flushStreamUpdate(assistantId, streamedText);
        await this.runImage(settings, imageCall.prompt, assistantId, streamedText, startedAt);
        return;
      }
      const finalText = streamedText || result.text;
      const usage = usageMeta(settings, result.usage);
      this.flushStreamUpdate(assistantId, finalText);
      this.updateMessage(assistantId, {
        content: finalText || "模型没有返回文本内容。",
        pending: false,
        error: !finalText,
        meta: [settings.chatModel, elapsedText(startedAt), usage.text].filter(Boolean).join(" · "),
      });
      speechText = finalText;
    } catch (error) {
      this.handleRequestError(assistantId, error, streamedText, settings.chatModel, startedAt);
    } finally {
      this._activeRequest = null;
      this.setData({ busy: false });
      if (speechText && settings.autoSpeak) this.speakText(speechText, settings);
    }
  },

  performChatRequest(settings, messages, onDelta, includeTools) {
    const operation = createChatCompletion({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.chatModel,
      messages,
      tools: includeTools && isImageConfigured(settings) ? [IMAGE_TOOL] : [],
      useCloudProxy: settings.useCloudProxy,
      onDelta,
    });
    this._activeRequest = operation;
    return operation.promise;
  },

  scheduleStreamUpdate(id, content) {
    this._pendingStream = { id, content };
    if (this._updateTimer) return;
    this._updateTimer = setTimeout(() => {
      this._updateTimer = null;
      const pending = this._pendingStream;
      this._pendingStream = null;
      if (pending) this.updateMessage(pending.id, { content: pending.content }, null, false);
    }, 60);
  },

  flushStreamUpdate(id, content) {
    if (this._updateTimer) clearTimeout(this._updateTimer);
    this._updateTimer = null;
    this._pendingStream = null;
    this.updateMessage(id, { content }, null, false);
  },

  async runImage(settings, prompt, assistantId, existingText = "", startedAt = Date.now()) {
    this.updateMessage(assistantId, { type: "image", prompt, content: existingText, pending: true, error: false });
    try {
      const operation = createImage({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.imageModel,
        prompt,
        size: IMAGE_SIZES[this.data.imageSizeIndex],
        quality: IMAGE_QUALITIES[this.data.imageQualityIndex],
        style: IMAGE_STYLES[this.data.imageStyleIndex],
        useCloudProxy: settings.useCloudProxy,
      });
      this._activeRequest = operation;
      const response = await operation.promise;
      const image = await materializeImage(response);
      recordUsage({ imageCount: 1, estimatedCost: settings.imagePrice });
      this.updateMessage(assistantId, {
        imageUrl: image.url,
        content: existingText || response.revisedPrompt || "",
        pending: false,
        error: false,
        meta: `${settings.imageModel} · ${elapsedText(startedAt)}${settings.imagePrice ? ` · $${settings.imagePrice.toFixed(4)}` : ""}`,
      });
    } catch (error) {
      this.handleRequestError(assistantId, error, existingText, settings.imageModel, startedAt);
    } finally {
      this._activeRequest = null;
      this.setData({ busy: false });
    }
  },

  handleRequestError(id, error, partialText, model, startedAt) {
    if (error && error.aborted) {
      this.updateMessage(id, { content: partialText || "已停止", pending: false, error: false, meta: `${model} · 已停止` });
      return;
    }
    this.updateMessage(id, {
      content: partialText || (error && error.message) || "请求失败，请稍后重试。",
      pending: false,
      error: true,
      meta: `${model} · ${elapsedText(startedAt)}`,
    });
  },

  async regenerateMessage(event) {
    if (this.data.busy) return;
    const assistantIndex = this.data.messages.findIndex((item) => item.id === event.currentTarget.dataset.id);
    if (assistantIndex <= 0) return;
    const userMessage = this.data.messages[assistantIndex - 1];
    if (!userMessage || userMessage.role !== "user") return;
    const settings = getSettings();
    const assistant = {
      id: newMessageId(), role: "assistant", type: userMessage.sourceMode === "image" ? "image" : "text",
      sourceMode: userMessage.sourceMode, content: "", prompt: userMessage.content, pending: true, error: false, meta: "",
    };
    const messages = this.data.messages.slice(0, assistantIndex).concat(assistant);
    this.setData({ messages, busy: true, mode: userMessage.sourceMode || "chat" });
    saveConversation(messages);
    if (userMessage.sourceMode === "image") await this.runImage(settings, userMessage.content, assistant.id);
    else await this.runChat(settings, assistant.id);
  },

  editMessage(event) {
    if (this.data.busy) return;
    const index = this.data.messages.findIndex((item) => item.id === event.currentTarget.dataset.id);
    const message = this.data.messages[index];
    if (!message || message.role !== "user") return;
    wx.showModal({
      title: "编辑问题",
      editable: true,
      placeholderText: "输入修改后的问题",
      content: message.content,
      success: (result) => {
        const content = String(result.content || "").trim();
        if (!result.confirm || !content) return;
        const messages = this.data.messages.slice(0, index);
        this.setData({ messages, inputValue: content, attachment: message.attachment || null, mode: message.sourceMode || "chat" }, () => this.send());
        saveConversation(messages);
      },
    });
  },

  selectImageSize(event) {
    this.setData({ imageSizeIndex: Number(event.detail.value) });
    this.persistImageOptions();
  },

  selectImageQuality(event) {
    this.setData({ imageQualityIndex: Number(event.detail.value) });
    this.persistImageOptions();
  },

  selectImageStyle(event) {
    this.setData({ imageStyleIndex: Number(event.detail.value) });
    this.persistImageOptions();
  },

  persistImageOptions() {
    setTimeout(() => {
      const settings = getSettings();
      saveSettings({
        ...settings,
        imageSize: IMAGE_SIZES[this.data.imageSizeIndex],
        imageQuality: IMAGE_QUALITIES[this.data.imageQualityIndex],
        imageStyle: IMAGE_STYLES[this.data.imageStyleIndex],
      });
    }, 0);
  },

  applyImageTemplate(event) {
    const template = IMAGE_TEMPLATES[Number(event.currentTarget.dataset.index)];
    if (template) this.setData({ inputValue: `${template.prompt}${this.data.inputValue}` });
  },

  toggleAutoSpeak() {
    const settings = getSettings();
    const autoSpeak = !settings.autoSpeak;
    saveSettings({ ...settings, autoSpeak });
    this.setData({ autoSpeak });
    wx.showToast({ title: autoSpeak ? "已开启自动朗读" : "已关闭自动朗读", icon: "none" });
    if (!autoSpeak) this.stopSpeech();
  },

  speakMessage(event) {
    const content = event.currentTarget.dataset.content;
    if (this.data.speaking) return this.stopSpeech();
    if (content) this.speakText(content, getSettings());
  },

  async speakText(content, settings) {
    const text = cleanSpeechText(content);
    if (!text || this._unloaded) return;
    this.stopSpeech();
    const session = {};
    this._speechSession = session;
    this.setData({ speaking: true });
    try {
      session.request = synthesizeSpeech({
        text,
        voice: settings.ttsVoice,
        rate: settings.ttsRate,
        volume: settings.ttsVolume,
        pitch: settings.ttsPitch,
      });
      const result = await session.request.promise;
      session.request = null;
      session.fileId = result.fileId;
      session.localPath = result.localPath;
      if (this._speechSession !== session) return;
      if (!session.localPath && session.fileId) {
        // Download through the cloud SDK so playback does not require an audio URL domain.
        const downloaded = await new Promise((resolve, reject) => {
          session.download = wx.cloud.downloadFile({
            fileID: session.fileId,
            success: resolve,
            fail: (error) => reject(new Error(`朗读音频下载失败：${error.errMsg || "请稍后重试"}`)),
          });
        });
        session.download = null;
        session.localPath = downloaded.tempFilePath;
      }
      if (this._speechSession !== session) return;
      if (!session.localPath) throw new Error("无法读取朗读音频");
      const audio = wx.createInnerAudioContext();
      session.audio = audio;
      audio.obeyMuteSwitch = false;
      audio.onEnded(() => {
        if (this._speechSession === session) this.stopSpeech();
      });
      audio.onError(() => {
        if (this._speechSession !== session) return;
        wx.showToast({ title: "音频播放失败", icon: "none" });
        this.stopSpeech();
      });
      audio.src = session.localPath;
      audio.play();
    } catch (error) {
      if (this._speechSession !== session) return;
      if (!error.aborted) wx.showModal({
        title: "朗读失败",
        content: error.message || "Edge TTS 暂时不可用。",
        showCancel: false,
        confirmText: "知道了",
      });
      this.stopSpeech();
    } finally {
      // Stopped requests can still finish downloading; clean up their late result.
      if (this._speechSession !== session) this.releaseSpeechSession(session);
    }
  },

  releaseSpeechSession(session) {
    if (!session) return;
    for (const key of ["request", "download"]) {
      const operation = session[key];
      session[key] = null;
      if (operation && operation.abort) {
        try { operation.abort(); } catch (_) {}
      }
    }
    if (session.audio) {
      const audio = session.audio;
      session.audio = null;
      try { audio.stop(); } catch (_) {}
      try { audio.destroy(); } catch (_) {}
    }
    if (session.localPath && wx.getFileSystemManager) {
      const filePath = session.localPath;
      session.localPath = "";
      try { wx.getFileSystemManager().unlink({ filePath, fail() {} }); } catch (_) {}
    }
    if (session.fileId && wx.cloud && wx.cloud.deleteFile) {
      const fileId = session.fileId;
      session.fileId = "";
      try { wx.cloud.deleteFile({ fileList: [fileId], fail() {} }); } catch (_) {}
    }
  },

  stopSpeech() {
    const session = this._speechSession;
    this._speechSession = null;
    this.releaseSpeechSession(session);
    if (!this._unloaded && this.data && this.data.speaking) this.setData({ speaking: false });
  },

  stop() {
    this.abortActiveRequest();
  },

  abortActiveRequest() {
    if (this._activeRequest && this._activeRequest.abort) this._activeRequest.abort();
  },

  newConversation() {
    if (this.data.busy) return;
    const conversation = createConversation();
    this._activeConversationId = conversation.id;
    this.setData({ messages: [], inputValue: "", attachment: null });
  },

  copyMessage(event) {
    const content = event.currentTarget.dataset.content;
    if (content) wx.setClipboardData({ data: content });
  },

  previewImage(event) {
    const url = event.currentTarget.dataset.url;
    if (url) wx.previewImage({ current: url, urls: [url] });
  },

  saveImage(event) {
    const source = event.currentTarget.dataset.url;
    if (!source) return;
    const save = (filePath) => wx.saveImageToPhotosAlbum({
      filePath,
      success: () => wx.showToast({ title: "已保存" }),
      fail: (error) => {
        if (!String(error.errMsg || "").includes("cancel")) wx.showToast({ title: "保存失败", icon: "none" });
      },
    });
    if (/^cloud:\/\//i.test(source)) {
      wx.showLoading({ title: "下载图片" });
      wx.cloud.downloadFile({
        fileID: source,
        success: (result) => save(result.tempFilePath),
        fail: () => wx.showToast({ title: "图片下载失败", icon: "none" }),
        complete: () => wx.hideLoading(),
      });
    } else if (!/^https:\/\//i.test(source)) {
      save(source);
    } else {
      wx.showLoading({ title: "下载图片" });
      wx.downloadFile({
        url: source,
        success: (result) => result.statusCode >= 200 && result.statusCode < 300
          ? save(result.tempFilePath)
          : wx.showToast({ title: "图片下载失败", icon: "none" }),
        fail: () => wx.showToast({ title: "图片下载失败", icon: "none" }),
        complete: () => wx.hideLoading(),
      });
    }
  },
});
